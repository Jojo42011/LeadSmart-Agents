import axios, { AxiosInstance } from "axios";

/**
 * Ringba API for the CPL updater. Isolated from the scrub and fraud clients so
 * nothing here can affect those systems.
 *
 * Write endpoint (confirmed from DevTools):
 *   POST /{accountId}/calls/payments/override
 *   { inboundCallId, NewConversionAmount, NewPayoutAmount,
 *     adjustConversion: true, adjustPayout: true, reason }
 *   → { result: { payoutAmount, conversionAmount } } immediately (no job queue).
 */

const BASE_URL = "https://api.ringba.com/v2";
const PAGE_SIZE = 100;
/**
 * Pagination runs until Ringba returns a short page (the real end). This is
 * only a runaway backstop against an infinite loop — set high enough that a
 * normal busy week never hits it (100k calls). Truncation is reported so the
 * UI can warn if it ever does.
 */
const SAFETY_MAX_PAGES = 1000;
const PAGE_DELAY_MS = 500;

/** CPL buyers whose calls this tool operates on. */
export const CPL_TARGET_MARKERS = ["33 miles rtt -", "inquirly"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccountId(): string {
  const accountId = process.env.RINGBA_ACCOUNT_ID;
  if (!accountId) throw new Error("RINGBA_ACCOUNT_ID is not set");
  return accountId;
}

function createClient(): AxiosInstance {
  const token = process.env.RINGBA_API_TOKEN;
  if (!token) throw new Error("RINGBA_API_TOKEN is not set");
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
  });
}

export interface CplCall {
  inboundCallId: string;
  callDt: string;
  callDtMs: number;
  callerNumber: string;
  callerLast10: string;
  trackingNumber: string; // the DID the caller dialed (file "Tracking Number")
  trackingLast10: string;
  publisherName: string;
  target: string;
  isCplTargetName: boolean; // target/campaign/buyer/publisher matched a CPL marker
  conversionAmount: number;
  payoutAmount: number;
}

type RawRow = Record<string, unknown>;

function str(row: RawRow, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? "" : String(v);
}
function num(row: RawRow, key: string): number {
  const v = row[key];
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isNaN(n) ? 0 : n;
}

/** Last 10 digits — robust to +1, 1-, formatting. */
export function last10(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Parse Ringba's callDt into epoch milliseconds. This account returns callDt as
 * a numeric epoch STRING (e.g. "1783332479708" = milliseconds; a ~10-digit value
 * would be seconds), not an ISO date — so `new Date(callDt)` yields Invalid Date
 * and matching silently fails. Handle numeric strings directly and still fall
 * back to Date parsing for ISO-formatted values from other accounts.
 */
export function parseCallDtMs(callDt: string): number {
  const s = String(callDt || "").trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return NaN;
    // 12+ digits → epoch milliseconds; shorter (~10 digits) → epoch seconds.
    return s.length >= 12 ? n : n * 1000;
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function isCplTarget(label: string): boolean {
  const lower = label.trim().toLowerCase();
  if (!lower) return false;
  return CPL_TARGET_MARKERS.some((m) => lower.includes(m));
}

const COLUMNS = [
  "inboundCallId",
  "callDt",
  "inboundPhoneNumber",
  "number",
  "numberId",
  "numberPoolName",
  "publisherName",
  "campaignName",
  "targetName",
  "buyer",
  "conversionAmount",
  "payoutAmount",
  "hasConverted",
];

/**
 * The DID the caller dialed (the file's "Tracking Number"). Ringba exposes this
 * as the dialed/number column; the exact key varies by account, so read the
 * first non-empty of the candidates. Used for diagnostics/fallback, not the
 * primary key (a DID is shared across many calls, so it isn't unique per call).
 */
const TRACKING_NUMBER_COLUMNS = ["number", "numberId", "numberPoolName"];

function trackingNumberOf(row: RawRow): string {
  for (const c of TRACKING_NUMBER_COLUMNS) {
    const v = str(row, c);
    if (v) return v;
  }
  return "";
}

/**
 * Columns scanned for the CPL marker ("33 miles rtt -" / "inquirly"). In this
 * account targetName/buyer are often empty on converted calls, so the buyer's
 * identity lives in campaignName (or the publisher). Scanning all of them finds
 * the marker wherever Ringba puts it, while the precise marker strings keep the
 * scope narrow — only these two CPL buyers ever match.
 */
const TARGET_LABEL_COLUMNS = [
  "campaignName",
  "targetName",
  "buyer",
  "publisherName",
];

function targetLabel(row: RawRow): string {
  return TARGET_LABEL_COLUMNS.map((c) => str(row, c))
    .filter(Boolean)
    .join(" ");
}

/**
 * Page through a Ringba call-log query until a short page (fewer than PAGE_SIZE
 * records) is returned — that is the true end. Only stops early at the runaway
 * backstop, which sets `truncated`. Extracted so pagination is unit-testable.
 */
export async function paginateAllRecords(
  fetchPage: (offset: number, size: number) => Promise<RawRow[]>,
): Promise<{ records: RawRow[]; truncated: boolean }> {
  const all: RawRow[] = [];
  let offset = 0;
  let pages = 0;

  for (;;) {
    pages += 1;
    const records = await fetchPage(offset, PAGE_SIZE);
    all.push(...records);

    if (records.length < PAGE_SIZE) {
      return { records: all, truncated: false }; // reached the end
    }
    if (pages >= SAFETY_MAX_PAGES) {
      console.warn(
        "[Fraud/CPL] pagination hit safety cap of %d pages (%d records) — window may be incomplete",
        SAFETY_MAX_PAGES,
        all.length,
      );
      return { records: all, truncated: true };
    }
    offset += PAGE_SIZE;
    await sleep(PAGE_DELAY_MS);
  }
}

/**
 * Converted CPL-target calls (33 Miles RTT / Inquirly) in [startIso, endIso].
 * Restricting to CPL targets keeps the strip scenarios from ever touching
 * other buyers' revenue. Fetches ALL pages before filtering.
 */
export async function fetchCplCalls(
  startIso: string,
  endIso: string,
): Promise<{ calls: CplCall[]; truncated: boolean }> {
  const client = createClient();
  const accountId = getAccountId();

  const { records: all, truncated } = await paginateAllRecords(
    async (offset, size) => {
      // NOTE: no hasConverted filter. The CPL leads we need to SET revenue on
      // have NOT converted yet ($0), so filtering by hasConverted excluded the
      // exact calls we must find. We pull every call in the window and scope to
      // CPL targets (33 Miles / Inquirly) client-side below.
      const res = await client.post<{ report?: { records?: RawRow[] } }>(
        `/${accountId}/calllogs`,
        {
          reportStart: startIso,
          reportEnd: endIso,
          size,
          offset,
          valueColumns: COLUMNS.map((column) => ({ column })),
          orderByColumns: [{ column: "callDt", direction: "asc" }],
        },
      );
      return res.data?.report?.records ?? [];
    },
  );

  // ---- Diagnostics: expose why matching may find nothing ----
  // Print the RAW shape of the first few rows so we can see the exact format of
  // callDt / inboundPhoneNumber / dialed number / target coming back from
  // Ringba, plus how many rows survive the CPL-target filter.
  console.log(
    "[CPL] fetchCplCalls window %s → %s : %d rows fetched (truncated=%s)",
    startIso,
    endIso,
    all.length,
    truncated,
  );
  if (all.length > 0) {
    const sample = all.slice(0, 5).map((row) => ({
      callDt: str(row, "callDt"),
      callDtMs: parseCallDtMs(str(row, "callDt")),
      inboundPhoneNumber: str(row, "inboundPhoneNumber"),
      callerLast10: last10(str(row, "inboundPhoneNumber")),
      trackingNumber: trackingNumberOf(row),
      number: str(row, "number"),
      numberId: str(row, "numberId"),
      numberPoolName: str(row, "numberPoolName"),
      campaignName: str(row, "campaignName"),
      targetName: str(row, "targetName"),
      buyer: str(row, "buyer"),
      publisherName: str(row, "publisherName"),
      conversionAmount: num(row, "conversionAmount"),
      payoutAmount: num(row, "payoutAmount"),
    }));
    console.log("[CPL] sample raw rows: %s", JSON.stringify(sample));
  }
  let cplTargetCount = 0;
  let unparseableDt = 0;
  let emptyCaller = 0;
  let withRevenue = 0;
  let trackingPopulated = 0;

  // NOTE: we no longer drop non-CPL-target calls here. Ringba's campaign/target
  // naming is unreliable (33 Miles calls come in under differently-named
  // campaigns), so we return EVERY call in the window and let the matcher scope
  // writes by the FILE: revenue is only set on calls a billable file row claims
  // (caller + time, tracking # as tiebreaker), and strips are limited to 33
  // Miles calls (marker name OR a tracking # that appears in the file). The
  // isCplTargetName flag is retained only for that strip scoping.
  const calls: CplCall[] = [];
  for (const row of all) {
    const inboundCallId = str(row, "inboundCallId");
    if (!inboundCallId) continue;
    const target = targetLabel(row);
    const isTgt = isCplTarget(target);
    if (isTgt) cplTargetCount += 1;

    const callDt = str(row, "callDt");
    const callerNumber = str(row, "inboundPhoneNumber");
    const trackingNumber = trackingNumberOf(row);
    const callDtMs = parseCallDtMs(callDt);
    const conversionAmount = num(row, "conversionAmount");
    if (Number.isNaN(callDtMs)) unparseableDt += 1;
    if (!last10(callerNumber)) emptyCaller += 1;
    if (conversionAmount > 0) withRevenue += 1;
    if (last10(trackingNumber)) trackingPopulated += 1;
    calls.push({
      inboundCallId,
      callDt,
      callDtMs,
      callerNumber,
      callerLast10: last10(callerNumber),
      trackingNumber,
      trackingLast10: last10(trackingNumber),
      publisherName: str(row, "publisherName"),
      target,
      isCplTargetName: isTgt,
      conversionAmount,
      payoutAmount: num(row, "payoutAmount"),
    });
  }

  console.log(
    "[CPL] %d calls in window | CPL-target-named: %d | withRevenue: %d | tracking# populated: %d | unparseable callDt: %d | empty caller: %d",
    calls.length,
    cplTargetCount,
    withRevenue,
    trackingPopulated,
    unparseableDt,
    emptyCaller,
  );

  return { calls, truncated };
}

export interface OverrideResult {
  payoutAmount: number;
  conversionAmount: number;
}

/**
 * Set a call's revenue (conversion) and payout to absolute values.
 * Both adjust flags true so a 0/0 override strips the call entirely.
 */
export async function overrideCallPayments(
  inboundCallId: string,
  newConversionAmount: number,
  newPayoutAmount: number,
  reason = "CPL adjustment - 33 Miles RTT",
): Promise<OverrideResult> {
  const client = createClient();
  const accountId = getAccountId();

  const res = await client.post<{ result?: OverrideResult }>(
    `/${accountId}/calls/payments/override`,
    {
      inboundCallId,
      NewConversionAmount: newConversionAmount,
      NewPayoutAmount: newPayoutAmount,
      adjustConversion: true,
      adjustPayout: true,
      reason,
    },
  );

  const result = res.data?.result;
  return {
    payoutAmount: result?.payoutAmount ?? newPayoutAmount,
    conversionAmount: result?.conversionAmount ?? newConversionAmount,
  };
}

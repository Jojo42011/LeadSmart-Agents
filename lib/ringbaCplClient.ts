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
const MAX_PAGES = 25;
const PAGE_DELAY_MS = 800;

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
  publisherName: string;
  target: string;
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

function isCplTarget(label: string): boolean {
  const lower = label.trim().toLowerCase();
  if (!lower) return false;
  return CPL_TARGET_MARKERS.some((m) => lower.includes(m));
}

const COLUMNS = [
  "inboundCallId",
  "callDt",
  "inboundPhoneNumber",
  "publisherName",
  "targetName",
  "buyer",
  "conversionAmount",
  "payoutAmount",
  "hasConverted",
];

/**
 * Converted CPL-target calls (33 Miles RTT / Inquirly) in [startIso, endIso].
 * Restricting to CPL targets keeps the strip scenarios from ever touching
 * other buyers' revenue.
 */
export async function fetchCplCalls(
  startIso: string,
  endIso: string,
): Promise<{ calls: CplCall[]; truncated: boolean }> {
  const client = createClient();
  const accountId = getAccountId();
  const all: RawRow[] = [];
  let offset = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages += 1;
    const res = await client.post<{ report?: { records?: RawRow[] } }>(
      `/${accountId}/calllogs`,
      {
        reportStart: startIso,
        reportEnd: endIso,
        size: PAGE_SIZE,
        offset,
        filters: [
          {
            anyMatch: true,
            filters: [
              { column: "hasConverted", value: "true", isNegativeMatch: false },
            ],
          },
        ],
        valueColumns: COLUMNS.map((column) => ({ column })),
        orderByColumns: [{ column: "callDt", direction: "asc" }],
      },
    );
    const records = res.data?.report?.records ?? [];
    all.push(...records);
    if (records.length < PAGE_SIZE) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
    offset += PAGE_SIZE;
    await sleep(PAGE_DELAY_MS);
  }

  const calls: CplCall[] = [];
  for (const row of all) {
    const inboundCallId = str(row, "inboundCallId");
    if (!inboundCallId) continue;
    const target = [str(row, "targetName"), str(row, "buyer")]
      .filter(Boolean)
      .join(" ");
    if (!isCplTarget(target)) continue;

    const callDt = str(row, "callDt");
    const callerNumber = str(row, "inboundPhoneNumber");
    calls.push({
      inboundCallId,
      callDt,
      callDtMs: callDt ? new Date(callDt).getTime() : NaN,
      callerNumber,
      callerLast10: last10(callerNumber),
      publisherName: str(row, "publisherName"),
      target,
      conversionAmount: num(row, "conversionAmount"),
      payoutAmount: num(row, "payoutAmount"),
    });
  }

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

import axios, { AxiosInstance } from "axios";

/**
 * Ringba API calls for System 3 fraud detection.
 * Deliberately separate from lib/ringbaClient.ts (scrub) so fraud work can
 * never alter scrub behavior.
 *
 * Endpoints used (Ringba API v2, https://developers.ringba.com/):
 *  - POST /{accountId}/calllogs                — converted calls w/ caller number + recording
 *  - GET  /{accountId}/Affiliates              — publishers (affiliates): id, name, enabled
 *  - PATCH /{accountId}/Affiliates/{id}        — plain-object body; { enabled: false } blocks
 */

const BASE_URL = "https://api.ringba.com/v2";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const PAGE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccountId(): string {
  const accountId = process.env.RINGBA_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }
  return accountId;
}

function createClient(): AxiosInstance {
  const token = process.env.RINGBA_API_TOKEN;
  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
  });
}

export interface FraudCallRecord {
  inboundCallId: string;
  callDt: string | null;
  publisherName: string;
  inboundPhoneNumber: string | null;
  payoutAmount: number;
  targetName: string | null;
  buyer: string | null;
  recordingUrl: string | null;
}

interface RawCallRow {
  [key: string]: unknown;
}

function readStr(row: RawCallRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function readNum(row: RawCallRow, key: string): number {
  const value = row[key];
  const num = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isNaN(num) ? 0 : num;
}

function normalizeCallRow(row: RawCallRow): FraudCallRecord | null {
  const inboundCallId = readStr(row, "inboundCallId");
  const publisherName = readStr(row, "publisherName");
  if (!inboundCallId || !publisherName) {
    return null;
  }
  return {
    inboundCallId,
    callDt: readStr(row, "callDt"),
    publisherName,
    inboundPhoneNumber: readStr(row, "inboundPhoneNumber"),
    payoutAmount: readNum(row, "payoutAmount"),
    targetName: readStr(row, "targetName") ?? readStr(row, "target"),
    buyer: readStr(row, "buyer"),
    recordingUrl: readStr(row, "recordingUrl"),
  };
}

const CALL_COLUMNS_FULL = [
  "inboundCallId",
  "callDt",
  "publisherName",
  "inboundPhoneNumber",
  "payoutAmount",
  "targetName",
  "buyer",
  "hasConverted",
  "recordingUrl",
];

/** Retry set for accounts whose calllogs reject the recordingUrl column. */
const CALL_COLUMNS_NO_RECORDING = CALL_COLUMNS_FULL.filter(
  (column) => column !== "recordingUrl"
);

async function fetchPage(
  client: AxiosInstance,
  accountId: string,
  reportStart: string,
  reportEnd: string,
  columns: string[],
  offset: number
): Promise<RawCallRow[]> {
  const response = await client.post<{
    report?: { records?: RawCallRow[] };
  }>(`/${accountId}/calllogs`, {
    reportStart,
    reportEnd,
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
    valueColumns: columns.map((column) => ({ column })),
    orderByColumns: [{ column: "callDt", direction: "asc" }],
  });
  return response.data?.report?.records ?? [];
}

/**
 * Converted calls in [reportStart, reportEnd] with caller number + recording.
 * Falls back to a column set without recordingUrl if the full set is rejected.
 */
export async function fetchConvertedCallsForFraud(
  reportStart: string,
  reportEnd: string
): Promise<{ calls: FraudCallRecord[]; truncated: boolean }> {
  const client = createClient();
  const accountId = getAccountId();

  let columns = CALL_COLUMNS_FULL;
  const all: RawCallRow[] = [];
  let offset = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages += 1;
    let records: RawCallRow[];
    try {
      records = await fetchPage(client, accountId, reportStart, reportEnd, columns, offset);
    } catch (err) {
      if (
        columns === CALL_COLUMNS_FULL &&
        axios.isAxiosError(err) &&
        err.response?.status === 400
      ) {
        console.warn(
          "[Fraud/Ringba] calllogs rejected full column set (%s) — retrying without recordingUrl",
          JSON.stringify(err.response?.data ?? null)
        );
        columns = CALL_COLUMNS_NO_RECORDING;
        records = await fetchPage(client, accountId, reportStart, reportEnd, columns, offset);
      } else {
        throw err;
      }
    }

    all.push(...records);
    if (records.length < PAGE_SIZE) {
      break;
    }
    if (pages >= MAX_PAGES) {
      truncated = true;
      console.warn(
        "[Fraud/Ringba] calllogs window truncated at %d pages — remainder picked up next scan",
        MAX_PAGES
      );
      break;
    }
    offset += PAGE_SIZE;
    await sleep(PAGE_DELAY_MS);
  }

  const calls = all
    .map(normalizeCallRow)
    .filter((row): row is FraudCallRecord => row !== null);

  return { calls, truncated };
}

// ---------- affiliates (publishers) ----------

export interface RingbaAffiliate {
  id: string;
  name: string;
  enabled: boolean;
}

function parseAffiliate(value: unknown): RingbaAffiliate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  const name = typeof row.name === "string" ? row.name : null;
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    enabled: row.enabled !== false,
  };
}

function extractAffiliateList(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object") {
    const root = data as Record<string, unknown>;
    for (const key of ["affiliates", "Affiliates", "items", "results", "data"]) {
      if (Array.isArray(root[key])) {
        return root[key] as unknown[];
      }
    }
  }
  return [];
}

export async function listRingbaAffiliates(): Promise<RingbaAffiliate[]> {
  const client = createClient();
  const accountId = getAccountId();
  const response = await client.get<unknown>(`/${accountId}/Affiliates`);
  return extractAffiliateList(response.data)
    .map(parseAffiliate)
    .filter((row): row is RingbaAffiliate => row !== null);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Match a Ringba affiliate to a call-log publisher name (exact, then containment). */
export function matchAffiliateByName(
  affiliates: RingbaAffiliate[],
  publisherName: string
): RingbaAffiliate | null {
  const target = normalizeName(publisherName);
  for (const affiliate of affiliates) {
    if (normalizeName(affiliate.name) === target) {
      return affiliate;
    }
  }
  for (const affiliate of affiliates) {
    const name = normalizeName(affiliate.name);
    if (name.includes(target) || target.includes(name)) {
      return affiliate;
    }
  }
  return null;
}

/**
 * Enable/disable an affiliate — `enabled: false` is Ringba's publisher pause,
 * which stops routing that publisher's calls account-wide.
 * PATCH body is a plain object per the Affiliates API.
 */
export async function setRingbaAffiliateEnabled(
  affiliateId: string,
  enabled: boolean
): Promise<{ httpStatus: number; body: unknown }> {
  const client = createClient();
  const accountId = getAccountId();

  console.log(
    "[Fraud/Ringba] PATCH Affiliates/%s enabled=%s",
    affiliateId,
    enabled
  );

  try {
    const response = await client.patch<unknown>(
      `/${accountId}/Affiliates/${encodeURIComponent(affiliateId)}`,
      { enabled }
    );
    console.log(
      "[Fraud/Ringba] PATCH Affiliates/%s response %d: %s",
      affiliateId,
      response.status,
      JSON.stringify(response.data ?? null)
    );
    return { httpStatus: response.status, body: response.data };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(
        "[Fraud/Ringba] PATCH Affiliates/%s failed %s: %s",
        affiliateId,
        err.response?.status ?? "network",
        JSON.stringify(err.response?.data ?? null)
      );
      throw new Error(
        `Ringba affiliate update failed (${err.response?.status ?? "network"}): ` +
          JSON.stringify(err.response?.data ?? err.message)
      );
    }
    throw err;
  }
}

/**
 * Download a call recording. Ringba recording URLs redirect to the media file;
 * include the API token when the URL points at api.ringba.com.
 */
export async function downloadRecording(recordingUrl: string): Promise<Buffer> {
  const token = process.env.RINGBA_API_TOKEN;
  const isRingbaApi = recordingUrl.includes("ringba.com");
  const response = await axios.get<ArrayBuffer>(recordingUrl, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 120_000,
    maxContentLength: 50 * 1024 * 1024,
    headers:
      isRingbaApi && token ? { Authorization: `Token ${token}` } : undefined,
  });
  return Buffer.from(response.data);
}

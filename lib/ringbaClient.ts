import axios, { AxiosInstance } from "axios";

const BASE_URL = "https://api.ringba.com/v2";
const CALLLOGS_PAGE_SIZE = 100;
const CALLLOGS_MAX_PAGES = 3;
const LIST_PAGE_DELAY_MS = 1000;

const QUERY1_HOURS = 4;
const QUERY2_START_HOURS = 72;
const QUERY2_END_HOURS = 4;

/** Call log row from Ringba calllogs report. */
export interface CallLogRecord {
  inboundCallId: string;
  publisherName?: string;
  payoutAmount?: number | string | null;
  wasConversionAdjusted?: boolean | string;
  hasPayout?: boolean | string;
  hasConverted?: boolean | string;
  buyer?: string;
  buyerId?: string;
  convAdjustmentRequestCount?: number | string | null;
  conversionAmount?: number | string | null;
  wasPayoutAdjusted?: boolean | string;
  convAdjustmentsApproved?: boolean | string;
  callDt?: string | number;
  [key: string]: unknown;
}

/** Call detail row from Ringba calllogs/detail. */
export interface CallDetailRecord {
  inboundCallId?: string;
  callDt?: string | number;
  payoutAmount?: number | string | null;
  conversionAmount?: number | string | null;
  events?: Array<{ name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Result payload from Ringba void endpoint. */
export interface VoidResult {
  [key: string]: unknown;
}

/** Two-window list fetch before merge. */
export interface MergedCallLogsResult {
  query1Records: CallLogRecord[];
  query2Records: CallLogRecord[];
  query2PagesFetched: number;
  merged: CallLogRecord[];
}

interface FetchWindowOptions {
  orderDirection: "asc" | "desc";
  maxPages?: number;
}

interface FetchWindowResult {
  records: CallLogRecord[];
  pagesFetched: number;
}

/** Thrown when Ringba returns 401 — credentials invalid. */
export class RingbaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RingbaAuthError";
  }
}

function formatRingba401Message(error: import("axios").AxiosError): string {
  const status = error.response?.status ?? 401;
  const statusText = error.response?.statusText ?? "";
  const data = error.response?.data;
  const parts = [
    `Ringba API returned ${status}${statusText ? ` ${statusText}` : ""} Unauthorized`,
  ];
  if (data !== undefined) {
    parts.push(`response body: ${JSON.stringify(data)}`);
  } else {
    parts.push("response body: (empty)");
  }
  parts.push("check RINGBA_API_TOKEN");
  return parts.join(" | ");
}

function throwRingbaAuthError(error: import("axios").AxiosError): never {
  throw new RingbaAuthError(formatRingba401Message(error));
}

/** Thrown when Ringba returns 429 — rate limited. */
export class RingbaRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RingbaRateLimitError";
  }
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

function handleAxiosError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401) {
      throwRingbaAuthError(error);
    }
    if (status === 429) {
      throw new RingbaRateLimitError(
        "Ringba API returned 429 Too Many Requests"
      );
    }
  }
  throw error;
}

/**
 * Parses numeric amount fields from Ringba (payout, conversion, etc.).
 */
export function parsePayoutAmount(
  value: number | string | null | undefined
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (Number.isNaN(num)) {
    return null;
  }
  return num;
}

const CALLLOGS_VALUE_COLUMNS: Array<{ column: string }> = [
  { column: "inboundCallId" },
  { column: "publisherName" },
  { column: "payoutAmount" },
  { column: "conversionAmount" },
  { column: "hasConverted" },
  { column: "buyer" },
  { column: "callDt" },
];

function dedupeByInboundCallId(records: CallLogRecord[]): CallLogRecord[] {
  const seen = new Set<string>();
  const merged: CallLogRecord[] = [];

  for (const record of records) {
    const id = String(record.inboundCallId ?? "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(record);
  }

  return merged;
}

/**
 * Fetches converted calls in a time window with configurable sort and page cap.
 */
async function fetchConvertedCallLogsWindow(
  reportStart: Date,
  reportEnd: Date,
  options: FetchWindowOptions
): Promise<FetchWindowResult> {
  const client = createClient();
  const accountId = getAccountId();
  const pageSize = CALLLOGS_PAGE_SIZE;
  const allRecords: CallLogRecord[] = [];
  let offset = 0;
  let pageNumber = 0;

  try {
    for (;;) {
      pageNumber += 1;
      const postBody = {
        reportStart: reportStart.toISOString(),
        reportEnd: reportEnd.toISOString(),
        size: pageSize,
        offset,
        filters: [
          {
            anyMatch: true,
            filters: [
              { column: "hasConverted", value: "true", isNegativeMatch: false },
            ],
          },
        ],
        valueColumns: CALLLOGS_VALUE_COLUMNS,
        orderByColumns: [
          { column: "callDt", direction: options.orderDirection },
        ],
      };

      const response = await client.post<{
        report?: { records?: CallLogRecord[] };
      }>(`/${accountId}/calllogs`, postBody);

      const records = response.data?.report?.records ?? [];
      allRecords.push(...records);

      if (records.length < pageSize) {
        break;
      }

      if (
        options.maxPages !== undefined &&
        pageNumber >= options.maxPages
      ) {
        break;
      }

      offset += pageSize;
      await sleep(LIST_PAGE_DELAY_MS);
    }
  } catch (error) {
    handleAxiosError(error);
  }

  return { records: allRecords, pagesFetched: pageNumber };
}

/**
 * Query 1: last 4 hours. Query 2: 4h–72h ago. Merged, deduped by inboundCallId.
 */
export async function getMergedConvertedCallLogs(): Promise<MergedCallLogsResult> {
  const now = Date.now();
  const query1 = await fetchConvertedCallLogsWindow(
    new Date(now - QUERY1_HOURS * 60 * 60 * 1000),
    new Date(now),
    { orderDirection: "desc", maxPages: CALLLOGS_MAX_PAGES }
  );

  await sleep(LIST_PAGE_DELAY_MS);

  const query2 = await fetchConvertedCallLogsWindow(
    new Date(now - QUERY2_START_HOURS * 60 * 60 * 1000),
    new Date(now - QUERY2_END_HOURS * 60 * 60 * 1000),
    { orderDirection: "asc" }
  );

  const merged = dedupeByInboundCallId([
    ...query1.records,
    ...query2.records,
  ]);

  return {
    query1Records: query1.records,
    query2Records: query2.records,
    query2PagesFetched: query2.pagesFetched,
    merged,
  };
}

/**
 * Fetches detail for a single inbound call ID.
 */
export async function getCallDetail(
  inboundCallId: string
): Promise<CallDetailRecord> {
  const client = createClient();
  const accountId = getAccountId();

  try {
    const response = await client.post<{
      report?: { records?: CallDetailRecord[] };
    }>(`/${accountId}/calllogs/detail`, {
      InboundCallIds: [inboundCallId],
    });

    const records = response.data?.report?.records ?? [];
    if (records.length === 0) {
      return { inboundCallId, payoutAmount: null, events: [] };
    }
    return records[0];
  } catch (error) {
    handleAxiosError(error);
  }
}

const VOID_MAX_RETRIES = 3;
const VOID_RETRY_BASE_MS = 60_000;

/** Amounts to pass into Ringba void (payout optional when already zeroed). */
export interface VoidCallAmounts {
  payoutAmount: number;
  conversionAmount: number;
}

function buildVoidPayload(
  inboundCallId: string,
  amounts: VoidCallAmounts
): Record<string, unknown> {
  const { payoutAmount, conversionAmount } = amounts;

  const base: Record<string, unknown> = {
    inboundCallId,
    voidReason: "Automated scrub — buyer conversion adjustment approved",
  };

  if (payoutAmount > 0 && conversionAmount > 0) {
    return {
      ...base,
      voidPayout: true,
      voidPayoutAmount: payoutAmount,
      voidConversion: true,
      voidConverionAmount: conversionAmount,
    };
  }

  if (payoutAmount === 0 && conversionAmount > 0) {
    return {
      ...base,
      voidConversion: true,
      voidConverionAmount: conversionAmount,
    };
  }

  if (payoutAmount > 0) {
    return {
      ...base,
      voidPayout: true,
      voidPayoutAmount: payoutAmount,
    };
  }

  throw new Error(
    `No voidable amounts for ${inboundCallId} (payout=${payoutAmount}, conversion=${conversionAmount})`
  );
}

/**
 * Voids conversion (revenue) and/or payout on a call per buyer adjustment approval.
 */
export async function voidCall(
  inboundCallId: string,
  amounts: VoidCallAmounts
): Promise<VoidResult> {
  const client = createClient();
  const accountId = getAccountId();

  const payload = buildVoidPayload(inboundCallId, amounts);

  let attempt = 0;

  while (attempt < VOID_MAX_RETRIES) {
    try {
      const response = await client.post<{
        result?: VoidResult;
        [key: string]: unknown;
      }>(`/${accountId}/calls/void`, payload);

      console.log(
        `[ScrubAgent] void response inboundCallId=${inboundCallId}:`,
        JSON.stringify(response.data, null, 2)
      );

      return response.data?.result ?? {};
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          throwRingbaAuthError(error);
        }
        if (status === 429) {
          attempt += 1;
          if (attempt >= VOID_MAX_RETRIES) {
            throw new RingbaRateLimitError(
              "Ringba API returned 429 after retries"
            );
          }
          const delayMs = VOID_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          await sleep(delayMs);
          continue;
        }
      }
      throw error;
    }
  }

  throw new RingbaRateLimitError("Ringba void failed after rate-limit retries");
}

const JOB_QUEUE_OPEN_STATUS = "open";
const CALL_VOID_CONVERSION_TYPE = "CallVoid_Conversion";
const JQI_PREFIX = "JQI_";
const PUBLIC_STATE_CONVERSION = "call Conversion";
const PUBLIC_STATE_PAYOUT = "call Payout";
const PUBLIC_STATE_PUBLISHER = "publisher Name";

/** Raw job row from GET jobQueue (camelCase API). */
export interface JobQueueItemRaw {
  id?: string;
  status?: string;
  type?: string;
  title?: string;
  publicState?: Record<string, { value?: unknown }>;
  public_state?: Record<string, { value?: unknown }>;
  [key: string]: unknown;
}

/** Parsed open CallVoid_Conversion task ready for void + approve. */
export interface OpenConversionVoidJob {
  jobId: string;
  inboundCallId: string;
  conversionAmount: number;
  payoutAmount: number;
  publisherName?: string;
  status?: string;
}

function getPublicState(
  job: JobQueueItemRaw
): Record<string, { value?: unknown }> | undefined {
  return job.publicState ?? job.public_state;
}

function readPublicStateAmount(
  state: Record<string, { value?: unknown }> | undefined,
  key: string
): number | null {
  const entry = state?.[key];
  if (entry === undefined || entry === null) {
    return null;
  }
  const raw = typeof entry === "object" && "value" in entry ? entry.value : entry;
  return parsePayoutAmount(raw as number | string | null | undefined);
}

function parseJobQueueItem(job: JobQueueItemRaw): OpenConversionVoidJob | null {
  if (job.type !== CALL_VOID_CONVERSION_TYPE) {
    return null;
  }

  const jobId = String(job.id ?? "").trim();
  if (!jobId.startsWith(JQI_PREFIX) || jobId.length <= JQI_PREFIX.length) {
    return null;
  }

  const inboundCallId = jobId.slice(JQI_PREFIX.length);
  const state = getPublicState(job);

  const conversionAmount = readPublicStateAmount(state, PUBLIC_STATE_CONVERSION);
  const payoutAmount = readPublicStateAmount(state, PUBLIC_STATE_PAYOUT);

  if (conversionAmount === null && payoutAmount === null) {
    return null;
  }

  const publisherRaw = state?.[PUBLIC_STATE_PUBLISHER]?.value;

  return {
    jobId,
    inboundCallId,
    conversionAmount: conversionAmount ?? 0,
    payoutAmount: payoutAmount ?? 0,
    publisherName:
      publisherRaw !== undefined && publisherRaw !== null
        ? String(publisherRaw)
        : undefined,
    status: job.status !== undefined ? String(job.status) : undefined,
  };
}

/**
 * Fetches open CallVoid_Conversion tasks from jobQueue (sole detection source).
 */
export async function getOpenCallVoidConversionJobs(): Promise<
  OpenConversionVoidJob[]
> {
  const client = createClient();
  const accountId = getAccountId();

  try {
    const response = await client.get<{
      jobs?: JobQueueItemRaw[];
    }>(`/${accountId}/jobQueue`, {
      params: { status: JOB_QUEUE_OPEN_STATUS },
    });

    const jobs = response.data?.jobs ?? [];
    const parsed: OpenConversionVoidJob[] = [];

    for (const job of jobs) {
      const item = parseJobQueueItem(job);
      if (item) {
        parsed.push(item);
      }
    }

    return parsed;
  } catch (error) {
    handleAxiosError(error);
  }
}

/** Substring in Ringba void/approve errors when conversion is already zero. */
export const CONVERSION_ALREADY_ZERO_VOID_MARKER =
  "Conversion would be brought below zero";

/** Args for jobQueue approve action on a conversion-adjustment task. */
export interface ApproveConversionAdjustmentArgs {
  amountConversion: number;
  amountPayout: number;
}

interface ApproveJobResponseBody {
  success?: boolean;
  job?: unknown;
  errors?: Array<{ errorMessage?: string }>;
}

function extractApproveErrorMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const data = body as ApproveJobResponseBody;
    const message = data.errors?.[0]?.errorMessage;
    if (message) {
      return message;
    }
  }
  return JSON.stringify(body);
}

/** Full Ringba approve HTTP response for caller inspection. */
export interface ApproveConversionAdjustmentResult {
  httpStatus: number;
  httpStatusText: string;
  body: unknown;
}

/**
 * Approves a conversion-adjustment task via jobQueue action (after void).
 */
export async function approveConversionAdjustmentJob(
  jobId: string,
  args: ApproveConversionAdjustmentArgs
): Promise<ApproveConversionAdjustmentResult> {
  const client = createClient();
  const accountId = getAccountId();

  const payload = {
    args: {
      amountConversion: args.amountConversion,
      amountPayout: args.amountPayout,
      actionName: "approve",
    },
  };

  try {
    const response = await client.post<unknown>(
      `/${accountId}/jobQueue/${encodeURIComponent(jobId)}/action`,
      payload
    );

    const result: ApproveConversionAdjustmentResult = {
      httpStatus: response.status,
      httpStatusText: response.statusText,
      body: response.data,
    };

    console.log(
      `[ScrubAgent] approval response jobId=${jobId}:`,
      JSON.stringify(result, null, 2)
    );

    const body = response.data;
    if (
      body &&
      typeof body === "object" &&
      (body as ApproveJobResponseBody).success === false
    ) {
      throw new Error(extractApproveErrorMessage(body));
    }

    return result;
  } catch (error) {
    handleAxiosError(error);
  }
}

/**
 * Verifies API credentials with a lightweight account list request.
 */
export async function healthCheck(): Promise<boolean> {
  const client = createClient();

  try {
    const response = await client.get("/ringbaaccounts");
    return response.status === 200;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

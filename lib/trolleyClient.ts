/**
 * Trolley (Payment Rails) client — Pakistan payout rail scaffold.
 *
 * Keys optional: without TROLLEY_ACCESS_KEY + TROLLEY_SECRET_KEY every
 * live call throws a clear error; widget signing and payouts stay inert.
 * Swap sandbox → live keys later with no code change.
 */
import * as crypto from "crypto";
import axios, { type AxiosRequestConfig } from "axios";

const DEFAULT_API_BASE = "https://api.trolley.com";
const DEFAULT_WIDGET_BASE = "https://widget.trolley.com";

export function isTrolleyConfigured(): boolean {
  return Boolean(
    process.env.TROLLEY_ACCESS_KEY?.trim() &&
      process.env.TROLLEY_SECRET_KEY?.trim()
  );
}

function getAccessKey(): string {
  const key = process.env.TROLLEY_ACCESS_KEY?.trim();
  if (!key) {
    throw new Error("TROLLEY_ACCESS_KEY is not configured");
  }
  return key;
}

function getSecretKey(): string {
  const secret = process.env.TROLLEY_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error("TROLLEY_SECRET_KEY is not configured");
  }
  return secret;
}

function getApiBase(): string {
  return (
    process.env.TROLLEY_API_BASE?.trim() || DEFAULT_API_BASE
  ).replace(/\/$/, "");
}

function getWidgetBase(): string {
  return (
    process.env.TROLLEY_WIDGET_BASE?.trim() || DEFAULT_WIDGET_BASE
  ).replace(/\/$/, "");
}

/** Stable refid for an affiliate — prefers Polyares Source ID when set. */
export function trolleyRefIdForAffiliate(
  publisherName: string,
  polyaresId?: string | null
): string {
  const poly = String(polyaresId ?? "").trim();
  if (poly) {
    return `ls-${poly.toLowerCase()}`;
  }
  const slug = publisherName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `ls-${slug || "affiliate"}`;
}

/**
 * White-label Widget invite URL (Seth's "send them a link" flow).
 * Signature is valid ~30s per Trolley docs — generate at click time.
 */
export function buildTrolleyWidgetInviteUrl(options: {
  email: string;
  refId: string;
  /** Comma-separated: bank-transfer, mobile-wallet, … */
  payoutMethods?: string;
}): string {
  const key = getAccessKey();
  const secret = getSecretKey();
  const email = options.email.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email is required for the Trolley invite link");
  }
  const refId = options.refId.trim();
  if (!refId) {
    throw new Error("Trolley refId is required");
  }

  const params = new URLSearchParams({
    ts: String(Math.floor(Date.now() / 1000)),
    key,
    email,
    refid: refId,
    hideEmail: "false",
    roEmail: "true",
    locale: "en",
    products: "pay",
    payoutMethods: options.payoutMethods?.trim() || "bank-transfer,mobile-wallet",
  });
  const querystring = params.toString().replace(/\+/g, "%20");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(querystring)
    .digest("hex");
  return `${getWidgetBase()}?${querystring}&sign=${signature}`;
}

function generateAuthorization(
  timestamp: number,
  endPoint: string,
  method: string,
  body: string = ""
): string {
  const hmac = crypto.createHmac("sha256", getSecretKey());
  hmac.update(`${timestamp}\n${method}\n${endPoint}\n${body}\n`);
  return `prsign ${getAccessKey()}:${hmac.digest("hex")}`;
}

async function trolleyRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endPoint: string,
  payload?: unknown
): Promise<T> {
  if (!isTrolleyConfigured()) {
    throw new Error(
      "Trolley is not configured (set TROLLEY_ACCESS_KEY and TROLLEY_SECRET_KEY)"
    );
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const body =
    method === "GET" || payload === undefined
      ? method === "GET"
        ? ""
        : "{}"
      : JSON.stringify(payload);
  const authorization = generateAuthorization(
    timestamp,
    endPoint,
    method,
    body
  );
  const config: AxiosRequestConfig = {
    url: `${getApiBase()}${endPoint}`,
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "X-PR-Timestamp": String(timestamp),
      "Trolley-Source": "leadsmart-ringba-scrub",
    },
    timeout: 60_000,
    validateStatus: () => true,
  };
  if (method !== "GET") {
    config.data = body;
  }

  const res = await axios(config);
  if (res.status >= 200 && res.status < 300) {
    return res.data as T;
  }
  const errBody = res.data;
  const detail =
    typeof errBody === "object" && errBody !== null
      ? JSON.stringify(errBody)
      : String(errBody ?? res.statusText);
  throw new Error(`Trolley API ${method} ${endPoint} → HTTP ${res.status}: ${detail}`);
}

export interface TrolleyRecipientSummary {
  id: string;
  referenceId: string | null;
  email: string | null;
  status: string | null;
  primaryCurrency: string | null;
  routeMinimum: number | null;
}

function parseRecipient(raw: unknown): TrolleyRecipientSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) {
    return null;
  }
  const routeRaw = row.routeMinimum;
  let routeMinimum: number | null = null;
  if (typeof routeRaw === "number" && Number.isFinite(routeRaw)) {
    routeMinimum = routeRaw;
  } else if (typeof routeRaw === "string" && routeRaw.trim()) {
    const n = parseFloat(routeRaw);
    if (Number.isFinite(n)) routeMinimum = n;
  }
  return {
    id,
    referenceId: typeof row.referenceId === "string" ? row.referenceId : null,
    email: typeof row.email === "string" ? row.email : null,
    status: typeof row.status === "string" ? row.status : null,
    primaryCurrency:
      typeof row.primaryCurrency === "string" ? row.primaryCurrency : null,
    routeMinimum,
  };
}

export async function getTrolleyRecipient(
  recipientId: string
): Promise<TrolleyRecipientSummary | null> {
  const id = recipientId.trim();
  if (!id) {
    return null;
  }
  const data = await trolleyRequest<{ recipient?: unknown }>(
    "GET",
    `/v1/recipients/${encodeURIComponent(id)}`
  );
  return parseRecipient(data?.recipient ?? data);
}

/** Search recipients and match on referenceId (our ls-… ref). */
export async function findTrolleyRecipientByRefId(
  refId: string
): Promise<TrolleyRecipientSummary | null> {
  const needle = refId.trim();
  if (!needle) {
    return null;
  }
  const data = await trolleyRequest<{
    recipients?: unknown[];
  }>("GET", `/v1/recipients?page=1&pageSize=100&search=${encodeURIComponent(needle)}`);
  const list = Array.isArray(data?.recipients) ? data.recipients : [];
  for (const item of list) {
    const parsed = parseRecipient(item);
    if (parsed && parsed.referenceId === needle) {
      return parsed;
    }
  }
  for (const item of list) {
    const parsed = parseRecipient(item);
    if (parsed && parsed.id === needle) {
      return parsed;
    }
  }
  return null;
}

export interface TrolleyPayoutResult {
  batchId: string;
  paymentId: string | null;
  status: string | null;
}

/**
 * Create a one-payment batch and start processing (auto-pay, like Wise).
 * amountUsd is the source amount LeadSmart owes.
 */
export async function executeTrolleyPayout(options: {
  recipientId: string;
  amountUsd: number;
  memo?: string;
}): Promise<TrolleyPayoutResult> {
  const recipientId = options.recipientId.trim();
  if (!recipientId.startsWith("R-")) {
    throw new Error("Trolley recipient ID must look like R-…");
  }
  if (!(options.amountUsd > 0) || !Number.isFinite(options.amountUsd)) {
    throw new Error("Trolley payout amount must be a positive number");
  }
  const amount = (Math.round(options.amountUsd * 100) / 100).toFixed(2);
  const memo = (options.memo || "LeadSmart affiliate payout").slice(0, 100);

  const created = await trolleyRequest<{
    batch?: { id?: string };
    id?: string;
  }>("POST", "/v1/batches", {
    sourceCurrency: "USD",
    description: memo,
    payments: [
      {
        recipient: { id: recipientId },
        sourceAmount: amount,
        memo,
      },
    ],
  });

  const batchId =
    (created.batch && typeof created.batch.id === "string"
      ? created.batch.id
      : null) ||
    (typeof created.id === "string" ? created.id : null);
  if (!batchId) {
    throw new Error("Trolley batch create did not return a batch id");
  }

  const started = await trolleyRequest<{
    batch?: { id?: string; status?: string };
    payments?: Array<{ id?: string; status?: string }>;
  }>("POST", `/v1/batches/${encodeURIComponent(batchId)}/start-processing`, {});

  const paymentId =
    Array.isArray(started.payments) && started.payments[0]?.id
      ? String(started.payments[0].id)
      : null;
  const status =
    (started.batch && typeof started.batch.status === "string"
      ? started.batch.status
      : null) ||
    (started.payments && started.payments[0]?.status
      ? String(started.payments[0].status)
      : null);

  return { batchId, paymentId, status };
}

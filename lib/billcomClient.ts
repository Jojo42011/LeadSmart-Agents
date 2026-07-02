import axios from "axios";
import {
  getBillcomMfaCredentials,
  saveBillcomMfaCredentials,
} from "./logger";

const BILLCOM_V2_BASE = "https://api.bill.com/api/v2";
const BILLCOM_GATEWAY_BASE = "https://gateway.bill.com/connect/v3";
export const BILLCOM_DEFAULT_DEVICE_ID = "leadsmart-fly-prod";

export class BillcomApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string | null = null
  ) {
    super(message);
    this.name = "BillcomApiError";
  }
}

export function isBillcomUntrustedSession(err: unknown): boolean {
  return err instanceof BillcomApiError && err.errorCode === "BDC_1361";
}

export interface BillcomVendor {
  id: string;
  name: string;
  email?: string | null;
}

export interface BillcomBill {
  id: string;
  vendorId: string;
  amount: number;
  description: string;
}

export interface BillcomPayment {
  id: string;
  billId: string;
  amount: number;
  status: string;
}

export interface BillcomBulkPaymentItem {
  billId: string;
  amount: number;
}

export interface BillcomBulkResult {
  succeeded: BillcomBulkPaymentItem[];
  failed: Array<{ billId: string; amount: number; error: string }>;
}

interface BillcomSession {
  sessionId: string;
  lastUsedAt: number;
}

let cachedSession: BillcomSession | null = null;
const SESSION_IDLE_MS = 35 * 60 * 1000;

function devKey(): string {
  const key = process.env.BILLCOM_DEV_KEY?.trim();
  if (!key) {
    throw new Error("BILLCOM_DEV_KEY is not configured");
  }
  return key;
}

function billcomEmail(): string {
  const email = process.env.BILLCOM_EMAIL?.trim();
  if (!email) {
    throw new Error("BILLCOM_EMAIL is not configured");
  }
  return email;
}

function billcomPassword(): string {
  const password = process.env.BILLCOM_PASSWORD?.trim();
  if (!password) {
    throw new Error("BILLCOM_PASSWORD is not configured");
  }
  return password;
}

function billcomOrgId(): string {
  const orgId = process.env.BILLCOM_ORG_ID?.trim();
  if (!orgId) {
    throw new Error("BILLCOM_ORG_ID is not configured");
  }
  return orgId;
}

function bankAccountId(): string {
  const id = process.env.BILLCOM_BANK_ACCOUNT_ID?.trim();
  if (!id) {
    throw new Error("BILLCOM_BANK_ACCOUNT_ID is not configured");
  }
  return id;
}

function optionalBankAccountId(): string | null {
  return process.env.BILLCOM_BANK_ACCOUNT_ID?.trim() ?? null;
}

function optionalMfaDeviceIdFromEnv(): string | null {
  return process.env.BILLCOM_DEVICE_ID?.trim() ?? null;
}

function optionalMfaIdFromEnv(): string | null {
  return process.env.BILLCOM_MFA_ID?.trim() ?? null;
}

export function getBillcomDeviceId(): string {
  const stored = getBillcomMfaCredentials();
  if (stored?.deviceId) {
    return stored.deviceId;
  }
  return optionalMfaDeviceIdFromEnv() ?? BILLCOM_DEFAULT_DEVICE_ID;
}

function resolveMfaForLogin(): { deviceId: string; mfaId: string | null } {
  const stored = getBillcomMfaCredentials();
  if (stored?.mfaId) {
    console.log(
      "[BillCom] login using stored MFA trust (deviceId=%s, saved %s)",
      stored.deviceId,
      stored.updatedAt
    );
    return { deviceId: stored.deviceId, mfaId: stored.mfaId };
  }

  const deviceId = optionalMfaDeviceIdFromEnv() ?? BILLCOM_DEFAULT_DEVICE_ID;
  const mfaId = optionalMfaIdFromEnv();
  if (mfaId) {
    console.log("[BillCom] login using MFA trust from env (deviceId=%s)", deviceId);
  } else {
    console.log("[BillCom] login without MFA trust — pay may require MFA code");
  }
  return { deviceId, mfaId };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function sessionExpired(session: BillcomSession): boolean {
  return Date.now() - session.lastUsedAt >= SESSION_IDLE_MS;
}

function extractBillcomError(row: Record<string, unknown>): {
  code: string | null;
  message: string;
} {
  const data = asRecord(row.response_data);
  const code =
    (data ? readString(data, "error_code") : null) ??
    readString(row, "error_code");
  const message =
    (data ? readString(data, "error_message") : null) ??
    readString(row, "error_message") ??
    readString(row, "response_message") ??
    "Bill.com request failed";
  return { code, message };
}

function assertBillcomOk(payload: unknown, context: string): Record<string, unknown> {
  const row = asRecord(payload);
  if (!row) {
    console.error("[BillCom] assertBillcomOk failed:", JSON.stringify(payload));
    throw new BillcomApiError(`${context}: empty response`);
  }

  const status = readNumber(row, "response_status");
  if (status !== null && status !== 0) {
    const { code, message } = extractBillcomError(row);
    console.error(
      "[BillCom] API error on %s: code=%s message=%s payload=%s",
      context,
      code ?? "unknown",
      message,
      JSON.stringify(payload)
    );
    throw new BillcomApiError(`${context}: ${message}`, code);
  }

  return row;
}

export function clearBillcomSession(): void {
  cachedSession = null;
  console.log("[BillCom] Cleared cached session");
}

export function setBillcomSession(sessionId: string): void {
  cachedSession = { sessionId, lastUsedAt: Date.now() };
  console.log("[BillCom] Set cached session");
}

export async function getBillcomSessionId(): Promise<string> {
  return getSession();
}

async function login(): Promise<string> {
  let res;
  try {
    const params = new URLSearchParams();
    params.append("devKey", devKey());
    params.append("userName", billcomEmail());
    params.append("password", billcomPassword());
    params.append("orgId", billcomOrgId());

    const { deviceId, mfaId } = resolveMfaForLogin();
    if (mfaId) {
      params.append("deviceId", deviceId);
      params.append("mfaId", mfaId);
    }

    console.log("[BillCom] Login.json request (user=%s, mfaTrusted=%s)", billcomEmail(), !!mfaId);

    res = await axios.post(`${BILLCOM_V2_BASE}/Login.json`, params, {
      timeout: 60_000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (err: any) {
    if (err.response?.data) {
      console.error(
        "[BillCom] login HTTP error body:",
        JSON.stringify(err.response.data)
      );
    }
    throw err;
  }

  const row = assertBillcomOk(res.data, "Bill.com login");
  const data = asRecord(row.response_data);
  const sessionId = data ? readString(data, "sessionId") : null;
  if (!sessionId) {
    throw new Error("Bill.com login did not return sessionId");
  }

  console.log("[BillCom] Login success, session established");
  cachedSession = { sessionId, lastUsedAt: Date.now() };
  return sessionId;
}

/** Get or create a Bill.com session (re-login after 35 min idle). */
export async function getSession(): Promise<string> {
  if (cachedSession && !sessionExpired(cachedSession)) {
    cachedSession.lastUsedAt = Date.now();
    return cachedSession.sessionId;
  }
  return login();
}

async function v2Request(
  endpoint: string,
  data: Record<string, unknown>,
  sessionIdOverride?: string
): Promise<Record<string, unknown>> {
  const sessionId = sessionIdOverride ?? (await getSession());
  const params = new URLSearchParams();
  params.append("devKey", devKey());
  params.append("sessionId", sessionId);
  params.append("data", JSON.stringify(data));

  console.log("[BillCom] POST %s", endpoint);

  const res = await axios.post(`${BILLCOM_V2_BASE}/${endpoint}`, params, {
    timeout: 60_000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!sessionIdOverride) {
    cachedSession = cachedSession
      ? { ...cachedSession, lastUsedAt: Date.now() }
      : { sessionId, lastUsedAt: Date.now() };
  } else {
    setBillcomSession(sessionId);
  }

  return assertBillcomOk(res.data, endpoint);
}

/** Send MFA token to registered Bill.com device; returns challengeId. */
export async function mfaChallenge(
  sessionIdOverride?: string
): Promise<{ challengeId: string; sessionId: string }> {
  const sessionId = sessionIdOverride ?? (await getSession());
  console.log("[BillCom] MFAChallenge.json — sending token to registered device");
  const row = await v2Request("MFAChallenge.json", {}, sessionId);
  const data = asRecord(row.response_data);
  const challengeId = data ? readString(data, "challengeId") : null;
  if (!challengeId) {
    throw new Error("Bill.com MFAChallenge did not return challengeId");
  }
  console.log("[BillCom] MFAChallenge success, challengeId=%s", challengeId);
  return { challengeId, sessionId };
}

/** Verify MFA code, save trust for 30 days, and mark session trusted. */
export async function mfaAuthenticateAndSave(
  challengeId: string,
  token: string,
  sessionId: string
): Promise<string> {
  const deviceId = getBillcomDeviceId();
  const maskedToken =
    token.length <= 2 ? "***" : `${token.slice(0, 1)}***${token.slice(-1)}`;
  console.log(
    "[BillCom] MFAAuthenticate.json request (deviceId=%s, token=%s, rememberMe=true)",
    deviceId,
    maskedToken
  );

  const row = await v2Request(
    "MFAAuthenticate.json",
    {
      challengeId,
      token,
      deviceId,
      machineName: "LeadSmart Payment Portal",
      rememberMe: true,
    },
    sessionId
  );

  const data = asRecord(row.response_data);
  const mfaId = data ? readString(data, "mfaId") : null;
  if (!mfaId) {
    console.error(
      "[BillCom] MFAAuthenticate response missing mfaId:",
      JSON.stringify(row.response_data)
    );
    throw new Error("Bill.com MFAAuthenticate did not return mfaId");
  }

  saveBillcomMfaCredentials(deviceId, mfaId);
  setBillcomSession(sessionId);
  console.log("[BillCom] MFAAuthenticate success — session trusted, mfaId saved");
  return mfaId;
}

function mapVendor(row: Record<string, unknown>): BillcomVendor | null {
  const id = readString(row, "id");
  const name = readString(row, "name");
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    email: readString(row, "email"),
  };
}

/** List all vendors. */
export async function listVendors(): Promise<BillcomVendor[]> {
  const vendors: BillcomVendor[] = [];
  let start = 0;
  const max = 999;

  while (true) {
    const row = await v2Request("List/Vendor.json", { start, max });
    const data = asRecord(row.response_data);
    const list = data && Array.isArray(data) ? data : [];
    if (list.length === 0) {
      break;
    }

    for (const item of list) {
      const vendorRow = asRecord(item);
      if (!vendorRow) {
        continue;
      }
      const vendor = mapVendor(vendorRow);
      if (vendor) {
        vendors.push(vendor);
      }
    }

    if (list.length < max) {
      break;
    }
    start += max;
  }

  return vendors;
}

/** Create a vendor if it does not already exist. */
export async function createVendor(
  name: string,
  email: string
): Promise<BillcomVendor> {
  const row = await v2Request("Crud/Create/Vendor.json", {
    obj: {
      entity: "Vendor",
      name,
      email,
      isActive: "1",
    },
  });

  const data = asRecord(row.response_data);
  const vendor = data ? mapVendor(data) : null;
  if (!vendor) {
    throw new Error("Bill.com vendor create response missing vendor");
  }
  return vendor;
}

/** Create a bill for a vendor. */
export async function createBill(
  vendorId: string,
  amount: number,
  description: string
): Promise<BillcomBill> {
  const invoiceDate = todayYmd();
  const row = await v2Request("Crud/Create/Bill.json", {
    obj: {
      entity: "Bill",
      vendorId,
      invoiceNumber: `LS-${Date.now()}`,
      invoiceDate,
      dueDate: invoiceDate,
      description,
      billLineItems: [
        {
          entity: "BillLineItem",
          amount,
          description,
        },
      ],
    },
  });

  const data = asRecord(row.response_data);
  const id = data ? readString(data, "id") : null;
  if (!id) {
    throw new Error("Bill.com bill create response missing id");
  }

  console.log("[BillCom] Bill created: id=%s vendorId=%s amount=%s", id, vendorId, amount);

  return {
    id,
    vendorId,
    amount,
    description,
  };
}

/** Pay a single bill (MFA-trusted session required). */
export async function payBill(
  billId: string,
  vendorId: string,
  amount: number
): Promise<BillcomPayment> {
  const processDate = todayYmd();
  const bac = optionalBankAccountId();
  console.log("[BillCom] PayBills request:", {
    billId,
    vendorId,
    amount,
    processDate,
    bankAccountId: bac ?? "(org primary)",
  });

  const payload: Record<string, unknown> = {
    vendorId,
    processDate,
    billPays: [{ billId, amount }],
  };
  if (bac) {
    payload.bankAccountId = bac;
  }

  const row = await v2Request("PayBills.json", payload);

  const data = asRecord(row.response_data);
  const sentPays =
    data && Array.isArray(data.sentPays)
      ? data.sentPays
      : data && Array.isArray(data)
        ? data
        : [];
  const sentPay = sentPays.length > 0 ? asRecord(sentPays[0]) : null;
  const id = sentPay ? readString(sentPay, "id") ?? billId : billId;
  const status = sentPay ? readString(sentPay, "status") ?? "submitted" : "submitted";

  console.log("[BillCom] PayBills success:", { paymentId: id, billId, amount, status });

  return {
    id,
    billId,
    amount,
    status,
  };
}

/** Create vendor + bill without paying (used when MFA may be required). */
export async function prepareBillcomPayout(
  publisherName: string,
  amount: number,
  existingVendors?: BillcomVendor[]
): Promise<{ billId: string; vendorId: string; amount: number }> {
  const vendors = existingVendors ?? (await listVendors());
  let vendor =
    vendors.find(
      (v) => v.name.trim().toLowerCase() === publisherName.trim().toLowerCase()
    ) ?? null;

  if (!vendor) {
    const slug = publisherName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
    const email = `${slug || "affiliate"}@leadsmart.payout`;
    vendor = await createVendor(publisherName, email);
  }

  const bill = await createBill(
    vendor.id,
    amount,
    `LeadSmart affiliate payout — ${publisherName}`
  );

  return {
    billId: bill.id,
    vendorId: vendor.id,
    amount,
  };
}

/** Bulk pay multiple bills (up to 50 per request). */
export async function bulkPayBills(
  payments: BillcomBulkPaymentItem[]
): Promise<BillcomBulkResult> {
  if (payments.length === 0) {
    return { succeeded: [], failed: [] };
  }

  const sessionId = await getSession();
  const succeeded: BillcomBulkPaymentItem[] = [];
  const failed: Array<{ billId: string; amount: number; error: string }> = [];

  for (let i = 0; i < payments.length; i += 50) {
    const batch = payments.slice(i, i + 50);
    try {
      const res = await axios.post(
        `${BILLCOM_GATEWAY_BASE}/payments/bulk`,
        {
          processDate: todayYmd(),
          fundingAccount: {
            type: "BANK_ACCOUNT",
            id: bankAccountId(),
          },
          payments: batch.map((payment) => ({
            billId: payment.billId,
            amount: payment.amount,
          })),
        },
        {
          timeout: 120_000,
          headers: {
            devKey: devKey(),
            sessionId,
            "Content-Type": "application/json",
          },
        }
      );

      const row = asRecord(res.data);
      const results =
        row && Array.isArray(row.results)
          ? row.results
          : row && Array.isArray(row.payments)
            ? row.payments
            : null;

      if (results) {
        for (let j = 0; j < results.length; j++) {
          const resultRow = asRecord(results[j]);
          const payment = batch[j];
          if (!payment) {
            continue;
          }
          if (resultRow && readString(resultRow, "status") === "FAILED") {
            failed.push({
              billId: payment.billId,
              amount: payment.amount,
              error:
                readString(resultRow, "error") ??
                readString(resultRow, "message") ??
                "Bulk payment failed",
            });
          } else {
            succeeded.push(payment);
          }
        }
      } else {
        succeeded.push(...batch);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bulk payment failed";
      for (const payment of batch) {
        failed.push({ ...payment, error: message });
      }
    }
  }

  return { succeeded, failed };
}

/** Find or create vendor, create bill, and pay it. */
export async function executeBillcomPayout(
  publisherName: string,
  amount: number,
  existingVendors?: BillcomVendor[]
): Promise<{ paymentId: string; billId: string; vendorId: string }> {
  const prepared = await prepareBillcomPayout(publisherName, amount, existingVendors);
  const payment = await payBill(prepared.billId, prepared.vendorId, amount);

  return {
    paymentId: payment.id,
    billId: prepared.billId,
    vendorId: prepared.vendorId,
  };
}

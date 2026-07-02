import axios from "axios";

const BILLCOM_V2_BASE = "https://api.bill.com/api/v2";
const BILLCOM_GATEWAY_BASE = "https://gateway.bill.com/connect/v3";

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

function assertBillcomOk(payload: unknown, context: string): Record<string, unknown> {
  const row = asRecord(payload);
  if (!row) {
    console.error("[BillCom] assertBillcomOk failed:", JSON.stringify(payload));
    throw new Error(`${context}: empty response`);
  }

  const status = readNumber(row, "response_status");
  if (status !== null && status !== 0) {
    console.error("[BillCom] assertBillcomOk failed:", JSON.stringify(payload));
    const message =
      readString(row, "response_message") ??
      readString(row, "error_message") ??
      "Bill.com request failed";
    throw new Error(`${context}: ${message}`);
  }

  return row;
}

async function login(): Promise<string> {
  let res;
  try {
    const params = new URLSearchParams();
    params.append("devKey", devKey());
    params.append("userName", billcomEmail());
    params.append("password", billcomPassword());
    params.append("orgId", billcomOrgId());

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
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const sessionId = await getSession();
  const params = new URLSearchParams();
  params.append("devKey", devKey());
  params.append("sessionId", sessionId);
  params.append("data", JSON.stringify(data));

  const res = await axios.post(`${BILLCOM_V2_BASE}/${endpoint}`, params, {
    timeout: 60_000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  cachedSession = cachedSession
    ? { ...cachedSession, lastUsedAt: Date.now() }
    : { sessionId, lastUsedAt: Date.now() };

  return assertBillcomOk(res.data, endpoint);
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
  const row = await v2Request("SendPay.json", {
    obj: {
      entity: "BillPay",
      billId,
      vendorId,
      amount,
      processDate: todayYmd(),
    },
  });

  const data = asRecord(row.response_data);
  const id = data ? readString(data, "id") ?? billId : billId;
  return {
    id,
    billId,
    amount,
    status: data ? readString(data, "status") ?? "submitted" : "submitted",
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
  const payment = await payBill(bill.id, vendor.id, amount);

  return {
    paymentId: payment.id,
    billId: bill.id,
    vendorId: vendor.id,
  };
}

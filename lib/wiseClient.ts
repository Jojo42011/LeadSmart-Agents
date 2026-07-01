import axios, { AxiosInstance } from "axios";
import { randomUUID } from "crypto";

const WISE_BASE_URL = "https://api.wise.com";

export interface WiseRecipient {
  id: number;
  accountHolderName: string;
  currency: string;
  country: string;
  email?: string | null;
}

export interface WiseQuote {
  id: string;
  sourceAmount: number;
  targetAmount: number;
  sourceCurrency: string;
  targetCurrency: string;
  rate: number;
}

export interface WiseTransfer {
  id: number;
  status: string;
  quoteUuid: string;
  customerTransactionId: string;
}

export interface WiseFundResult {
  status: string;
  type: string;
}

function wiseToken(): string {
  const token = process.env.WISE_API_TOKEN?.trim();
  if (!token) {
    throw new Error("WISE_API_TOKEN is not configured");
  }
  return token;
}

function wiseProfileId(): string {
  const profileId = process.env.WISE_PROFILE_ID?.trim();
  if (!profileId) {
    throw new Error("WISE_PROFILE_ID is not configured");
  }
  return profileId;
}

function createWiseClient(): AxiosInstance {
  return axios.create({
    baseURL: WISE_BASE_URL,
    headers: {
      Authorization: `Bearer ${wiseToken()}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
  });
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
  return typeof value === "number" ? value : null;
}

/** Get recipient accounts for a profile (matched by name/email on payout). */
export async function getRecipients(profileId: string): Promise<WiseRecipient[]> {
  const client = createWiseClient();
  const accountsRes = await client.get("/v2/accounts", {
    params: { profileId, currency: "USD" },
  });

  const accounts = Array.isArray(accountsRes.data) ? accountsRes.data : [];
  const recipients: WiseRecipient[] = [];

  for (const account of accounts) {
    const accountRow = asRecord(account);
    if (!accountRow) {
      continue;
    }
    const accountId = readNumber(accountRow, "id");
    if (accountId === null) {
      continue;
    }

    const recipientsRes = await client.get(
      `/v1/accounts/${accountId}/recipients`
    );
    const rows = Array.isArray(recipientsRes.data) ? recipientsRes.data : [];

    for (const row of rows) {
      const recipientRow = asRecord(row);
      if (!recipientRow) {
        continue;
      }
      const id = readNumber(recipientRow, "id");
      const accountHolderName = readString(recipientRow, "accountHolderName");
      if (id === null || !accountHolderName) {
        continue;
      }

      const details = asRecord(recipientRow.details) ?? {};
      recipients.push({
        id,
        accountHolderName,
        currency: readString(recipientRow, "currency") ?? "USD",
        country: readString(details, "country") ?? readString(recipientRow, "country") ?? "",
        email: readString(details, "email"),
      });
    }
  }

  return recipients;
}

/** Create a quote for a transfer. */
export async function createQuote(
  profileId: string,
  amount: number,
  targetCurrency: string
): Promise<WiseQuote> {
  const client = createWiseClient();
  const res = await client.post(`/v3/profiles/${profileId}/quotes`, {
    sourceCurrency: "USD",
    targetCurrency,
    sourceAmount: amount,
    paymentMetadata: {
      transferNature: "MOVING_MONEY_BETWEEN_OWN_ACCOUNTS",
    },
  });

  const row = asRecord(res.data);
  if (!row) {
    throw new Error("Wise quote response was empty");
  }

  const id = readString(row, "id");
  if (!id) {
    throw new Error("Wise quote response missing id");
  }

  return {
    id,
    sourceAmount: readNumber(row, "sourceAmount") ?? amount,
    targetAmount: readNumber(row, "targetAmount") ?? amount,
    sourceCurrency: readString(row, "sourceCurrency") ?? "USD",
    targetCurrency: readString(row, "targetCurrency") ?? targetCurrency,
    rate: readNumber(row, "rate") ?? 1,
  };
}

/** Create a transfer from a quote. */
export async function createTransfer(
  quoteUuid: string,
  targetAccountId: number,
  reference: string
): Promise<WiseTransfer> {
  const client = createWiseClient();
  const res = await client.post("/v1/transfers", {
    targetAccount: targetAccountId,
    quoteUuid,
    customerTransactionId: randomUUID(),
    details: {
      reference,
    },
  });

  const row = asRecord(res.data);
  if (!row) {
    throw new Error("Wise transfer response was empty");
  }

  const id = readNumber(row, "id");
  if (id === null) {
    throw new Error("Wise transfer response missing id");
  }

  return {
    id,
    status: readString(row, "status") ?? "unknown",
    quoteUuid: readString(row, "quoteUuid") ?? quoteUuid,
    customerTransactionId:
      readString(row, "customerTransactionId") ?? randomUUID(),
  };
}

/** Fund a transfer from Wise balance. */
export async function fundTransfer(
  profileId: string,
  transferId: number
): Promise<WiseFundResult> {
  const client = createWiseClient();
  const res = await client.post(
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    { type: "BALANCE" }
  );

  const row = asRecord(res.data);
  if (!row) {
    throw new Error("Wise fund response was empty");
  }

  return {
    status: readString(row, "status") ?? "unknown",
    type: readString(row, "type") ?? "BALANCE",
  };
}

/** Run quote → transfer → fund for one payout amount. */
export async function executeWisePayout(
  profileId: string,
  recipientId: number,
  amount: number,
  reference = "LeadSmart Affiliate Payout"
): Promise<{ transferId: number; quoteId: string }> {
  const quote = await createQuote(profileId, amount, "USD");
  const transfer = await createTransfer(quote.id, recipientId, reference);
  await fundTransfer(profileId, transfer.id);
  return { transferId: transfer.id, quoteId: quote.id };
}

export function getWiseProfileIdFromEnv(): string {
  return wiseProfileId();
}

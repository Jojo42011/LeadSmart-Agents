import axios, { AxiosInstance } from "axios";
import { randomUUID } from "crypto";

const WISE_BASE_URL = "https://api.wise.com";
const USD_ACH_REFERENCE_MAX_LENGTH = 10;
const DEFAULT_WISE_TRANSFER_REFERENCE = "LeadSmart";

function isPlaceholderWiseEmail(email: string): boolean {
  const norm = email.trim().toLowerCase();
  if (!norm) {
    return false;
  }
  return norm === "affiliate@example.com" || norm.endsWith("@example.com");
}

function isPlaceholderWiseTag(tag: string): boolean {
  const norm = tag.trim().toLowerCase().replace(/^@/, "");
  return norm === "username" || norm === "yourname";
}

/** USD ACH statements allow at most 10 characters for the reference field. */
export function normalizeWiseTransferReference(
  reference: string,
  targetCurrency = "USD"
): string {
  const trimmed = reference.trim() || DEFAULT_WISE_TRANSFER_REFERENCE;
  if (targetCurrency.toUpperCase() === "USD") {
    return trimmed.slice(0, USD_ACH_REFERENCE_MAX_LENGTH);
  }
  return trimmed.slice(0, 140);
}

function formatWiseApiError(err: unknown, step: string): Error {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err : new Error(`Wise ${step} failed`);
  }

  const status = err.response?.status;
  const parts = [`Wise ${step} failed${status ? ` (${status})` : ""}`];
  const record = asRecord(err.response?.data);

  if (record) {
    const errors = record.errors;
    if (Array.isArray(errors)) {
      for (const item of errors) {
        const row = asRecord(item);
        if (!row) {
          continue;
        }
        const message = readString(row, "message");
        const code = readString(row, "code");
        if (message) {
          parts.push(code ? `${code}: ${message}` : message);
        }
      }
    }

    const topMessage = readString(record, "message");
    if (topMessage) {
      parts.push(topMessage);
    }

    const errorCode = readString(record, "errorCode");
    const errorMessage = readString(record, "errorMessage");
    if (errorCode) {
      parts.push(
        errorMessage ? `${errorCode}: ${errorMessage}` : errorCode
      );
    }
  }

  console.error(`[Wise] ${step} error:`, JSON.stringify(err.response?.data ?? null));
  return new Error(parts.join(" — "));
}

async function runWiseStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    throw formatWiseApiError(err, step);
  }
}

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
  targetAccount?: number;
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

export interface WiseContact {
  contactId: string;
  name: string;
}

/** Parse numeric Wise API recipient ID from plain digits or a wise.com/recipients URL. */
export function parseWiseRecipientIdInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  const urlMatch = trimmed.match(/wise\.com\/recipients\/([^/?#]+)/i);
  if (urlMatch) {
    const segment = urlMatch[1];
    if (/^\d+$/.test(segment)) {
      return parseInt(segment, 10);
    }
    throw new Error(
      "Wise browser links use a UUID, not the API recipient ID. " +
        "Open the recipient in Wise and enter the numeric recipient ID (or list recipients via API)."
    );
  }

  throw new Error("Wise recipient ID must be a number (e.g. 40000000)");
}

export function formatWiseRecipientIdForStorage(recipientId: number): string {
  return String(recipientId);
}

/** Verify a stored recipient ID exists in Wise. */
export async function verifyWiseRecipientId(recipientId: number): Promise<boolean> {
  const client = createWiseClient();
  try {
    const res = await client.get(`/v2/accounts/${recipientId}`);
    const row = asRecord(res.data);
    const id = row ? readNumber(row, "id") : null;
    return id === recipientId;
  } catch {
    return false;
  }
}

function findRecipientById(
  recipients: WiseRecipient[],
  recipientId: number
): WiseRecipient | null {
  return recipients.find((recipient) => recipient.id === recipientId) ?? null;
}

export interface WisePayoutTarget {
  recipientId: number;
  resolvedVia: "recipient" | "contact" | "ach" | "stored";
}

export interface WiseAchDetails {
  accountHolderName: string;
  routingNumber: string;
  accountNumber: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
}

export function isWiseAchComplete(
  ach: Partial<WiseAchDetails> | null | undefined
): ach is WiseAchDetails {
  if (!ach) {
    return false;
  }
  return Boolean(
    ach.accountHolderName?.trim() &&
      ach.routingNumber?.trim() &&
      ach.accountNumber?.trim() &&
      ach.addressLine1?.trim() &&
      ach.city?.trim() &&
      ach.state?.trim() &&
      ach.zip?.trim()
  );
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

function parseQuoteRow(row: Record<string, unknown>, fallbackAmount: number): WiseQuote {
  const id = readString(row, "id");
  if (!id) {
    throw new Error("Wise quote response missing id");
  }

  return {
    id,
    sourceAmount: readNumber(row, "sourceAmount") ?? fallbackAmount,
    targetAmount: readNumber(row, "targetAmount") ?? fallbackAmount,
    sourceCurrency: readString(row, "sourceCurrency") ?? "USD",
    targetCurrency: readString(row, "targetCurrency") ?? "USD",
    rate: readNumber(row, "rate") ?? 1,
    targetAccount: readNumber(row, "targetAccount") ?? undefined,
  };
}

/** Normalize stored Wise tag for API (Wise accepts tag with or without @). */
export function normalizeWiseTagForApi(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

/** Pick email or tag identifier for Wise contact lookup (email preferred). */
export function resolveWiseIdentifier(
  wiseEmail: string | null | undefined,
  wiseTag: string | null | undefined
): string | null {
  const email = wiseEmail?.trim().toLowerCase() ?? "";
  if (email && !isPlaceholderWiseEmail(email)) {
    return email;
  }
  const tag = wiseTag?.trim() ?? "";
  if (tag && !isPlaceholderWiseTag(tag)) {
    return normalizeWiseTagForApi(tag);
  }
  return null;
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

function normalizeContactIdentifier(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function parseContactRow(value: unknown): WiseContact | null {
  const row = Array.isArray(value) && value.length > 0 ? value[0] : value;
  const record = asRecord(row);
  if (!record) {
    return null;
  }

  const contactId = readString(record, "contactId") ?? readString(record, "id");
  if (!contactId) {
    return null;
  }

  return {
    contactId,
    name: readString(record, "name") ?? "",
  };
}

async function findContactByIdentifier(
  profileId: string,
  identifier: string
): Promise<WiseContact | null> {
  const client = createWiseClient();
  const targetEmail = identifier.trim().toLowerCase();
  const targetTag = normalizeContactIdentifier(identifier);

  try {
    const res = await client.get(`/v2/profiles/${profileId}/contacts`);
    const rows = Array.isArray(res.data) ? res.data : [];

    for (const item of rows) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }

      const rowIdentifier = readString(record, "identifier");
      if (rowIdentifier) {
        const normEmail = rowIdentifier.trim().toLowerCase();
        const normTag = normalizeContactIdentifier(rowIdentifier);
        if (
          normEmail === targetEmail ||
          normTag === targetTag ||
          normEmail === targetTag
        ) {
          const parsed = parseContactRow(record);
          if (parsed) {
            return {
              contactId: parsed.contactId,
              name: parsed.name || rowIdentifier,
            };
          }
        }
      }

      const parsed = parseContactRow(record);
      if (!parsed) {
        continue;
      }
      const nameNorm = parsed.name.trim().toLowerCase();
      if (nameNorm === targetEmail || nameNorm === targetTag) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn(
      "[Wise] Failed to list contacts:",
      err instanceof Error ? err.message : err
    );
  }

  return null;
}

/** Find a Wise profile by email or Wisetag and add as contact (no bank details). */
export async function createContactFromIdentifier(
  profileId: string,
  identifier: string,
  targetCurrency = "USD"
): Promise<WiseContact> {
  const existing = await findContactByIdentifier(profileId, identifier);
  if (existing) {
    console.log("[Wise] Reusing existing contact for identifier: %s", identifier);
    return existing;
  }

  const client = createWiseClient();
  try {
    const res = await client.post(
      `/v2/profiles/${profileId}/contacts`,
      {
        identifier,
        targetCurrency,
      },
      { params: { isDirectIdentifierCreation: true } }
    );

    const parsed = parseContactRow(res.data);
    if (parsed) {
      return {
        contactId: parsed.contactId,
        name: parsed.name || identifier,
      };
    }

    console.error(
      "[Wise] Contact create returned unexpected body:",
      JSON.stringify(res.data)
    );
    throw new Error(
      "Wise contact response missing contactId — check server logs for response body"
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const fromBody = parseContactRow(err.response?.data);
      if (fromBody) {
        return {
          contactId: fromBody.contactId,
          name: fromBody.name || identifier,
        };
      }

      if (err.response?.status === 409) {
        const retry = await findContactByIdentifier(profileId, identifier);
        if (retry) {
          console.log(
            "[Wise] Contact already exists, reusing for identifier: %s",
            identifier
          );
          return retry;
        }
      }

      const wiseMessage = asRecord(err.response?.data)?.message;
      if (typeof wiseMessage === "string" && wiseMessage.trim()) {
        throw new Error(`Wise contact creation failed: ${wiseMessage.trim()}`);
      }
    }

    throw err instanceof Error ? err : new Error("Wise contact creation failed");
  }
}

/** Create a quote for a transfer funded from the Wise balance. */
export async function createQuote(
  profileId: string,
  amount: number,
  targetCurrency: string,
  options?: { contactId?: string; targetAccount?: number }
): Promise<WiseQuote> {
  return runWiseStep("quote create", async () => {
    const client = createWiseClient();
    const body: Record<string, unknown> = {
      sourceCurrency: "USD",
      targetCurrency,
      sourceAmount: amount,
      preferredPayIn: "BALANCE",
    };

    if (options?.contactId) {
      body.contactId = options.contactId;
    } else if (options?.targetAccount !== undefined) {
      body.targetAccount = options.targetAccount;
    }

    const res = await client.post(`/v3/profiles/${profileId}/quotes`, body);

    const row = asRecord(res.data);
    if (!row) {
      throw new Error("Wise quote response was empty");
    }

    return parseQuoteRow(row, amount);
  });
}

/** Create a transfer from a quote. */
export async function createTransfer(
  quoteUuid: string,
  targetAccountId: number,
  reference: string,
  targetCurrency = "USD"
): Promise<WiseTransfer> {
  return runWiseStep("transfer create", async () => {
    const client = createWiseClient();
    const bankReference = normalizeWiseTransferReference(reference, targetCurrency);
    const res = await client.post("/v1/transfers", {
      targetAccount: targetAccountId,
      quoteUuid,
      customerTransactionId: randomUUID(),
      details: {
        reference: bankReference,
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
  });
}

/** Fund a transfer from Wise balance. */
export async function fundTransfer(
  profileId: string,
  transferId: number
): Promise<WiseFundResult> {
  return runWiseStep("transfer fund", async () => {
    const client = createWiseClient();
    const res = await client.post(
      `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
      { type: "BALANCE" }
    );

    const row = asRecord(res.data);
    if (!row) {
      throw new Error("Wise fund response was empty");
    }

    const status = readString(row, "status") ?? "unknown";
    const errorCode = readString(row, "errorCode");
    const errorMessage = readString(row, "errorMessage");

    if (status === "REJECTED" || errorCode) {
      throw new Error(
        errorCode
          ? `${errorCode}${errorMessage ? `: ${errorMessage}` : ""}`
          : "Wise balance funding was rejected"
      );
    }

    return {
      status,
      type: readString(row, "type") ?? "BALANCE",
    };
  });
}

/** Match an existing saved recipient by stored email. */
export function matchWiseRecipientByEmail(
  recipients: WiseRecipient[],
  wiseEmail: string | null | undefined
): WiseRecipient | null {
  const email = wiseEmail?.trim().toLowerCase() ?? "";
  if (!email || isPlaceholderWiseEmail(email)) {
    return null;
  }

  for (const recipient of recipients) {
    const recipientEmail = recipient.email?.trim().toLowerCase();
    if (recipientEmail && recipientEmail === email) {
      return recipient;
    }
  }

  return null;
}

/** Create a USD ACH (ABA) recipient for cross-platform payouts. */
export async function createWiseAchRecipient(
  profileId: string,
  ach: WiseAchDetails
): Promise<{ recipientId: number }> {
  return runWiseStep("ACH recipient create", async () => {
  const client = createWiseClient();
  const res = await client.post("/v1/accounts", {
    currency: "USD",
    type: "aba",
    profile: profileId,
    ownedByCustomer: false,
    accountHolderName: ach.accountHolderName.trim(),
    details: {
      legalType: "PRIVATE",
      abartn: ach.routingNumber.trim(),
      accountNumber: ach.accountNumber.trim(),
      accountType: "CHECKING",
      address: {
        country: "US",
        state: ach.state.trim().toUpperCase(),
        city: ach.city.trim(),
        firstLine: ach.addressLine1.trim(),
        postCode: ach.zip.trim(),
      },
    },
  });

  const row = asRecord(res.data);
  const id = row ? readNumber(row, "id") : null;
  if (id === null) {
    throw new Error("Wise recipient create response missing id");
  }

  console.log(
    "[Wise] Created ACH recipient id=%s holder=%s",
    id,
    ach.accountHolderName.trim()
  );

  return { recipientId: id };
  });
}

/**
 * Resolve payout target: stored ID, email match, ACH, or Wise-to-Wise contact.
 */
export async function resolveWisePayoutTarget(
  profileId: string,
  recipients: WiseRecipient[],
  wiseEmail: string | null | undefined,
  wiseTag: string | null | undefined,
  achDetails?: Partial<WiseAchDetails> | null,
  storedRecipientId?: number | null
): Promise<WisePayoutTarget | { contactId: string; resolvedVia: "contact" }> {
  if (storedRecipientId !== null && storedRecipientId !== undefined) {
    const cached = findRecipientById(recipients, storedRecipientId);
    if (cached) {
      return { recipientId: cached.id, resolvedVia: "stored" };
    }
    const valid = await verifyWiseRecipientId(storedRecipientId);
    if (!valid) {
      throw new Error(
        `Wise recipient ID ${storedRecipientId} was not found. Update the stored ID in affiliate settings.`
      );
    }
    console.log(
      "[Wise] Using stored recipient ID for payout: %s",
      storedRecipientId
    );
    return { recipientId: storedRecipientId, resolvedVia: "stored" };
  }

  const existing = matchWiseRecipientByEmail(recipients, wiseEmail);
  if (existing) {
    return { recipientId: existing.id, resolvedVia: "recipient" };
  }

  if (isWiseAchComplete(achDetails)) {
    const created = await createWiseAchRecipient(profileId, achDetails);
    return { recipientId: created.recipientId, resolvedVia: "ach" };
  }

  const identifier = resolveWiseIdentifier(wiseEmail, wiseTag);
  if (identifier) {
    const contact = await createContactFromIdentifier(profileId, identifier, "USD");
    return { contactId: contact.contactId, resolvedVia: "contact" };
  }

  throw new Error(
    "Wise payout requires stored recipient ID, Wise email/tag (Wise-to-Wise), or full ACH + address (other platforms)"
  );
}

async function targetAccountFromQuote(
  profileId: string,
  amount: number,
  target: WisePayoutTarget | { contactId: string; resolvedVia: "contact" }
): Promise<{ quote: WiseQuote; targetAccountId: number }> {
  if ("recipientId" in target) {
    const quote = await createQuote(profileId, amount, "USD", {
      targetAccount: target.recipientId,
    });
    return {
      quote,
      targetAccountId: quote.targetAccount ?? target.recipientId,
    };
  }

  const quote = await createQuote(profileId, amount, "USD", {
    contactId: target.contactId,
  });
  const targetAccountId = quote.targetAccount;
  if (targetAccountId === undefined) {
    throw new Error("Wise quote did not resolve contact to a recipient account");
  }

  return { quote, targetAccountId };
}

function normalizePayoutTarget(
  target:
    | WisePayoutTarget
    | { contactId: string; resolvedVia: "contact" }
    | { recipientId: number }
): WisePayoutTarget | { contactId: string; resolvedVia: "contact" } {
  if ("recipientId" in target && !("resolvedVia" in target)) {
    return { recipientId: target.recipientId, resolvedVia: "recipient" };
  }
  return target;
}

/** Create quote + transfer without funding (for bulk pay batching). */
export async function prepareWiseTransfer(
  profileId: string,
  amount: number,
  target:
    | WisePayoutTarget
    | { contactId: string; resolvedVia: "contact" }
    | { recipientId: number },
  reference = DEFAULT_WISE_TRANSFER_REFERENCE
): Promise<{ transferId: number; quoteId: string }> {
  const normalizedTarget = normalizePayoutTarget(target);
  const { quote, targetAccountId } = await targetAccountFromQuote(
    profileId,
    amount,
    normalizedTarget
  );
  const transfer = await createTransfer(
    quote.id,
    targetAccountId,
    reference,
    quote.targetCurrency
  );
  console.log(
    "[Wise] Transfer created id=%s quote=%s reference=%s",
    transfer.id,
    quote.id,
    normalizeWiseTransferReference(reference, quote.targetCurrency)
  );
  return { transferId: transfer.id, quoteId: quote.id };
}

/** Run quote → transfer → fund for one payout amount. */
export async function executeWisePayout(
  profileId: string,
  amount: number,
  target:
    | WisePayoutTarget
    | { contactId: string; resolvedVia: "contact" }
    | { recipientId: number },
  reference = DEFAULT_WISE_TRANSFER_REFERENCE
): Promise<{ transferId: number; quoteId: string }> {
  const prepared = await prepareWiseTransfer(profileId, amount, target, reference);
  await fundTransfer(profileId, prepared.transferId);
  return prepared;
}

/** @deprecated Use executeWisePayout with a resolved target. */
export async function executeWisePayoutToRecipient(
  profileId: string,
  recipientId: number,
  amount: number,
  reference = DEFAULT_WISE_TRANSFER_REFERENCE
): Promise<{ transferId: number; quoteId: string }> {
  return executeWisePayout(profileId, amount, { recipientId }, reference);
}

export function getWiseProfileIdFromEnv(): string {
  return wiseProfileId();
}

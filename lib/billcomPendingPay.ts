import { randomUUID } from "crypto";

export interface PendingBillcomPay {
  mfaToken: string;
  challengeId: string;
  sessionId: string;
  billId: string;
  vendorId: string;
  amount: number;
  publisherName: string;
  newBankAccount: boolean;
  processDate?: string;
  months: string[];
  createdAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingByToken = new Map<string, PendingBillcomPay>();

function purgeExpired(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [token, entry] of pendingByToken) {
    if (entry.createdAt < cutoff) {
      pendingByToken.delete(token);
    }
  }
}

export function storePendingBillcomPay(
  entry: Omit<PendingBillcomPay, "mfaToken" | "createdAt">
): string {
  purgeExpired();
  const mfaToken = randomUUID();
  pendingByToken.set(mfaToken, {
    ...entry,
    mfaToken,
    createdAt: Date.now(),
  });
  console.log(
    "[Payment] Stored pending Bill.com pay awaiting MFA:",
    JSON.stringify({
      mfaToken,
      publisherName: entry.publisherName,
      billId: entry.billId,
      amount: entry.amount,
    })
  );
  return mfaToken;
}

export function takePendingBillcomPay(mfaToken: string): PendingBillcomPay | null {
  purgeExpired();
  const entry = pendingByToken.get(mfaToken);
  if (!entry) {
    return null;
  }
  pendingByToken.delete(mfaToken);
  return entry;
}

export function getPendingBillcomPay(mfaToken: string): PendingBillcomPay | null {
  purgeExpired();
  return pendingByToken.get(mfaToken) ?? null;
}

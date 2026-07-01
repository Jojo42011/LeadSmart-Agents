/** Warn on startup when payment provider env vars are missing. */
const PAYMENT_ENV_VARS = [
  "WISE_API_TOKEN",
  "WISE_PROFILE_ID",
  "BILLCOM_EMAIL",
  "BILLCOM_PASSWORD",
  "BILLCOM_ORG_ID",
  "BILLCOM_DEV_KEY",
] as const;

export function warnMissingPaymentEnvVars(): void {
  for (const key of PAYMENT_ENV_VARS) {
    if (!process.env[key]?.trim()) {
      console.warn(`[Payment] Missing env var: ${key} (Wise/Bill.com payouts disabled)`);
    }
  }

  if (!process.env.BILLCOM_BANK_ACCOUNT_ID?.trim()) {
    console.warn(
      "[Payment] Missing env var: BILLCOM_BANK_ACCOUNT_ID (Bill.com bulk payouts disabled)"
    );
  }
}

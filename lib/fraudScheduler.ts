import { runFraudScan, isFraudScanRunning } from "../agents/fraudAgent";

/**
 * System 3 fraud scan loop — independent of the scrub poll scheduler so the
 * two systems can never interfere. Default cadence 15 minutes.
 */

let timer: ReturnType<typeof setInterval> | null = null;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function fraudSchedulerEnabled(): boolean {
  if (process.env.FRAUD_ENABLED?.trim().toLowerCase() === "false") {
    return false;
  }
  return Boolean(
    process.env.RINGBA_API_TOKEN?.trim() && process.env.RINGBA_ACCOUNT_ID?.trim()
  );
}

export function startFraudScheduler(): void {
  if (timer) {
    return;
  }
  if (!fraudSchedulerEnabled()) {
    console.log(
      "[Fraud] Scheduler disabled (FRAUD_ENABLED=false or Ringba credentials missing)"
    );
    return;
  }

  const intervalMs = envInt("FRAUD_POLL_INTERVAL_MS", 15 * 60 * 1000);
  console.log("[Fraud] Scheduler started, interval %dms", intervalMs);

  // First scan shortly after boot so the dashboard has data without waiting
  // a full interval, but late enough not to compete with startup work.
  setTimeout(() => {
    void runFraudScan().catch((err) => {
      console.error(
        "[Fraud] Initial scan failed:",
        err instanceof Error ? err.message : err
      );
    });
  }, 15_000);

  timer = setInterval(() => {
    if (isFraudScanRunning()) {
      return;
    }
    void runFraudScan().catch((err) => {
      console.error(
        "[Fraud] Scheduled scan failed:",
        err instanceof Error ? err.message : err
      );
    });
  }, intervalMs);
}

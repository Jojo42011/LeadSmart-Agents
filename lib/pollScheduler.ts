import { runScrubAgent, type ScrubRunResult } from "../agents/scrubAgent";
import { healthCheck } from "./ringbaClient";
import { getDataDir, getDbPath } from "./paths";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let authStopped = false;
let pollInFlight: Promise<ScrubRunResult | null> | null = null;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

async function executePollCycle(): Promise<ScrubRunResult | null> {
  if (pollInFlight) {
    return null;
  }

  const timestamp = new Date().toISOString();
  console.log(`[ScrubAgent] Poll started at ${timestamp}`);

  pollInFlight = (async () => {
    try {
      const result = await runScrubAgent();

      if (result.authFailure) {
        authStopped = true;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      return result;
    } catch {
      return null;
    } finally {
      pollInFlight = null;
    }
  })();

  return pollInFlight;
}

export type TriggerPollResponse =
  | { status: "started"; result: ScrubRunResult | null }
  | { status: "already_running" }
  | { status: "auth_stopped" };

/** Runs one scrub cycle immediately (manual or scheduled). */
export async function triggerPollNow(): Promise<TriggerPollResponse> {
  if (authStopped) {
    return { status: "auth_stopped" };
  }
  if (pollInFlight) {
    return { status: "already_running" };
  }

  const result = await executePollCycle();
  return { status: "started", result };
}

export async function startPollScheduler(options: {
  runOnce?: boolean;
}): Promise<void> {
  const pollIntervalMs = envInt("POLL_INTERVAL_MS", 28_800_000);
  const hours = pollIntervalMs / 3_600_000;

  console.log(`[ScrubAgent] Data dir: ${getDataDir()}`);
  console.log(`[ScrubAgent] Database: ${getDbPath()}`);
  console.log(`[ScrubAgent] Poll interval: ${pollIntervalMs}ms (${hours}h)`);

  const healthy = await healthCheck();
  if (!healthy) {
    process.exit(1);
  }

  await executePollCycle();

  if (options.runOnce) {
    process.exit(authStopped ? 1 : 0);
  }

  pollTimer = setInterval(() => {
    if (authStopped) {
      return;
    }
    void executePollCycle();
  }, pollIntervalMs);
}

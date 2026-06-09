import axios from "axios";
import {
  approveConversionAdjustmentJob,
  getOpenCallVoidConversionJobs,
  RingbaAuthError,
  RingbaRateLimitError,
  voidCall,
  type OpenConversionVoidJob,
} from "../lib/ringbaClient";
import {
  logScrub,
  setLastSuccessfulPollAt,
  wasSuccessfullyProcessed,
} from "../lib/logger";

/** Result of a single scrub agent run. */
export interface ScrubRunResult {
  processed: number;
  skipped: number;
  errors: number;
  dryRuns: number;
  authFailure: boolean;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw.toLowerCase() === "true";
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ScrubErrorInfo {
  message: string;
  kind: string;
}

function classifyScrubError(error: unknown): ScrubErrorInfo {
  if (error instanceof RingbaRateLimitError) {
    return { message: error.message, kind: "429" };
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const kind =
      status === 429 ? "429" : status !== undefined ? `HTTP ${status}` : "axios";
    const body =
      error.response?.data !== undefined
        ? ` — ${JSON.stringify(error.response.data)}`
        : "";
    return {
      message: `${error.message}${body}`,
      kind,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, kind: error.name };
  }
  return { message: String(error), kind: "unknown" };
}

function voidAmountsFromJob(
  job: OpenConversionVoidJob
): { payout: number; conversion: number } | null {
  const payout = job.payoutAmount;
  const conversion = job.conversionAmount;

  if (payout <= 0 && conversion <= 0) {
    return null;
  }

  return { payout, conversion };
}

/**
 * Poll cycle: jobQueue open CallVoid_Conversion tasks → void → approve.
 */
export async function runScrubAgent(): Promise<ScrubRunResult> {
  const dryRun = envBool("DRY_RUN", true);
  const callDelayMs = envInt("CALL_DELAY_MS", 500);

  const result: ScrubRunResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
    dryRuns: 0,
    authFailure: false,
  };

  let jobs: OpenConversionVoidJob[];

  try {
    jobs = await getOpenCallVoidConversionJobs();
  } catch (error) {
    if (error instanceof RingbaAuthError) {
      result.authFailure = true;
      return result;
    }
    result.errors += 1;
    return result;
  }

  console.log(
    `[ScrubAgent] jobQueue open CallVoid_Conversion tasks: ${jobs.length}`
  );

  const errorSamples: Array<{ inboundCallId: string } & ScrubErrorInfo> = [];
  const errorKindCounts = new Map<string, number>();

  function recordError(inboundCallId: string, error: unknown): void {
    const { message, kind } = classifyScrubError(error);
    errorKindCounts.set(kind, (errorKindCounts.get(kind) ?? 0) + 1);
    if (errorSamples.length < 3) {
      errorSamples.push({ inboundCallId, message, kind });
    }
  }

  for (const job of jobs) {
    const { inboundCallId, jobId } = job;
    const publisherName = job.publisherName ?? "unknown";

    let voidSucceeded = false;
    let totalAmount = 0;
    let payoutAmount = 0;
    let conversionAmount = 0;

    try {
      if (wasSuccessfullyProcessed(inboundCallId)) {
        result.skipped += 1;
        continue;
      }

      const amounts = voidAmountsFromJob(job);
      if (!amounts) {
        result.skipped += 1;
        continue;
      }

      payoutAmount = amounts.payout;
      conversionAmount = amounts.conversion;
      totalAmount = payoutAmount + conversionAmount;

      if (dryRun) {
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: totalAmount,
          voidPayoutAmount: payoutAmount,
          voidConversionAmount: conversionAmount,
          status: "dry_run",
          taskId: jobId,
        });
        result.dryRuns += 1;
        continue;
      }

      await voidCall(inboundCallId, { payoutAmount, conversionAmount });
      voidSucceeded = true;

      const amountConversion =
        conversionAmount > 0 ? -conversionAmount : 0;

      await approveConversionAdjustmentJob(jobId, {
        amountConversion,
        amountPayout: 0,
      });

      console.log(
        `[ScrubAgent] SUCCESS $${totalAmount.toFixed(2)} ${publisherName}`
      );
      logScrub({
        inboundCallId,
        publisherName,
        amountVoided: totalAmount,
        voidPayoutAmount: payoutAmount,
        voidConversionAmount: conversionAmount,
        status: "success",
        taskId: jobId,
      });
      result.processed += 1;

      if (callDelayMs > 0) {
        await sleep(callDelayMs);
      }
    } catch (error) {
      if (error instanceof RingbaAuthError) {
        result.authFailure = true;
        return result;
      }

      const { message, kind } = classifyScrubError(error);
      recordError(inboundCallId, error);

      if (voidSucceeded) {
        console.log(
          `[ScrubAgent] VOID OK, APPROVE FAILED $${totalAmount.toFixed(2)} ${publisherName} — [${kind}] ${message}`
        );
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: totalAmount,
          voidPayoutAmount: payoutAmount,
          voidConversionAmount: conversionAmount,
          status: "void_success_approve_failed",
          errorMessage: `[${kind}] ${message}`,
          taskId: jobId,
        });
      } else {
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: null,
          status: "error",
          errorMessage: `[${kind}] ${message}`,
          taskId: jobId,
        });
      }
      result.errors += 1;

      if (callDelayMs > 0) {
        await sleep(callDelayMs);
      }
    }
  }

  if (!result.authFailure) {
    setLastSuccessfulPollAt(new Date().toISOString());
  }

  console.log(
    `[ScrubAgent] voided ${result.processed}, skipped ${result.skipped}, errors ${result.errors}`
  );

  if (result.errors > 0) {
    const breakdown = [...errorKindCounts.entries()]
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(", ");
    console.log(`[ScrubAgent] error breakdown: ${breakdown}`);
    for (const sample of errorSamples) {
      console.log(
        `[ScrubAgent] error sample inboundCallId=${sample.inboundCallId} [${sample.kind}]: ${sample.message}`
      );
    }
  }

  return result;
}

import axios from "axios";
import {
  approveConversionAdjustmentJob,
  CONVERSION_ALREADY_ZERO_VOID_MARKER,
  getOpenCallVoidConversionJobs,
  RingbaAuthError,
  RingbaRateLimitError,
  voidCall,
  type ApproveConversionAdjustmentArgs,
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

function formatAxiosErrorDetail(error: import("axios").AxiosError): string {
  const status = error.response?.status;
  const statusText = error.response?.statusText ?? "";
  const data = error.response?.data;
  const parts = [error.message];
  if (status !== undefined) {
    parts.push(
      `HTTP ${status}${statusText ? ` ${statusText}` : ""}`
    );
  }
  if (data !== undefined) {
    parts.push(`response body: ${JSON.stringify(data)}`);
  }
  return parts.join(" | ");
}

function classifyScrubError(error: unknown): ScrubErrorInfo {
  if (error instanceof RingbaRateLimitError) {
    return { message: error.message, kind: "429" };
  }
  if (error instanceof RingbaAuthError) {
    return { message: error.message, kind: "401" };
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const kind =
      status === 429 ? "429" : status !== undefined ? `HTTP ${status}` : "axios";
    return {
      message: formatAxiosErrorDetail(error),
      kind,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, kind: error.name };
  }
  return { message: String(error), kind: "unknown" };
}

function isConversionAlreadyAtZeroVoidError(error: unknown): boolean {
  return classifyScrubError(error).message.includes(
    CONVERSION_ALREADY_ZERO_VOID_MARKER
  );
}

interface ApproveLogContext {
  inboundCallId: string;
  taskId: string;
  publisherName: string;
}

async function runApproveWithZeroConversionRetry(
  jobId: string,
  approveArgs: ApproveConversionAdjustmentArgs,
  context: ApproveLogContext
): Promise<void> {
  const { inboundCallId, taskId, publisherName } = context;

  const logApproveCalled = (args: ApproveConversionAdjustmentArgs) => {
    logTaskStep("APPROVE_CALLED", {
      inboundCallId,
      taskId,
      publisherName,
      errorMessage: jsonForScrubLog({
        args: { ...args, actionName: "approve" },
      }),
    });
  };

  const logApproveSuccess = (approveResult: unknown) => {
    logTaskStep("APPROVE_SUCCESS", {
      inboundCallId,
      taskId,
      publisherName,
      errorMessage: jsonForScrubLog(approveResult),
    });
  };

  logApproveCalled(approveArgs);
  try {
    const approveResult = await approveConversionAdjustmentJob(jobId, approveArgs);
    logApproveSuccess(approveResult);
    return;
  } catch (firstError) {
    const alreadyZeroArgs =
      approveArgs.amountConversion === 0 && approveArgs.amountPayout === 0;
    if (!isConversionAlreadyAtZeroVoidError(firstError) || alreadyZeroArgs) {
      throw firstError;
    }

    const retryArgs: ApproveConversionAdjustmentArgs = {
      amountConversion: 0,
      amountPayout: 0,
    };
    logApproveCalled(retryArgs);
    const retryResult = await approveConversionAdjustmentJob(jobId, retryArgs);
    logApproveSuccess(retryResult);
  }
}

function logApproveFailureAfterVoid(
  context: ApproveLogContext & {
    totalAmount: number;
    payoutAmount: number;
    conversionAmount: number;
  },
  approveError: unknown
): void {
  const {
    inboundCallId,
    taskId,
    publisherName,
    totalAmount,
    payoutAmount,
    conversionAmount,
  } = context;
  const { message, kind } = classifyScrubError(approveError);

  logTaskStep("APPROVE_FAILED", {
    inboundCallId,
    taskId,
    publisherName,
    amountVoided: totalAmount,
    voidPayoutAmount: payoutAmount,
    voidConversionAmount: conversionAmount,
    errorMessage: message,
  });
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
    errorMessage: message,
    taskId,
  });
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

function jsonForScrubLog(value: unknown): string {
  return JSON.stringify(value);
}

function logTaskStep(
  status: string,
  opts: {
    inboundCallId: string;
    taskId: string;
    publisherName: string;
    amountVoided?: number | null;
    voidPayoutAmount?: number | null;
    voidConversionAmount?: number | null;
    errorMessage?: string | null;
  }
): void {
  const parts = [
    `inboundCallId=${opts.inboundCallId}`,
    `jobId=${opts.taskId}`,
    `publisherName=${opts.publisherName}`,
  ];
  if (opts.voidPayoutAmount != null) {
    parts.push(`payout=${opts.voidPayoutAmount}`);
  }
  if (opts.voidConversionAmount != null) {
    parts.push(`conversion=${opts.voidConversionAmount}`);
  }
  if (opts.errorMessage) {
    parts.push(`error=${opts.errorMessage}`);
  }
  console.log(`[ScrubAgent] ${status} ${parts.join(" ")}`);
  logScrub({
    inboundCallId: opts.inboundCallId,
    publisherName: opts.publisherName,
    amountVoided: opts.amountVoided ?? null,
    voidPayoutAmount: opts.voidPayoutAmount ?? null,
    voidConversionAmount: opts.voidConversionAmount ?? null,
    status: status as "skipped",
    errorMessage: opts.errorMessage ?? null,
    taskId: opts.taskId,
  });
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

    logTaskStep("TASK_STARTED", {
      inboundCallId,
      taskId: jobId,
      publisherName,
      amountVoided: 0,
      voidPayoutAmount: job.payoutAmount,
      voidConversionAmount: job.conversionAmount,
    });

    try {
      if (wasSuccessfullyProcessed(inboundCallId)) {
        console.log(
          `[ScrubAgent] SKIP (dedup) inboundCallId=${inboundCallId} jobId=${jobId}`
        );
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: 0,
          status: "skipped_dedup" as "skipped",
          taskId: jobId,
        });
        result.skipped += 1;
        continue;
      }

      const amounts = voidAmountsFromJob(job);
      if (!amounts) {
        console.log(
          `[ScrubAgent] SKIP (zero amounts) inboundCallId=${inboundCallId} jobId=${jobId}`
        );
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: 0,
          status: "skipped_zero_amounts" as "skipped",
          taskId: jobId,
        });
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

      logTaskStep("VOID_CALLED", {
        inboundCallId,
        taskId: jobId,
        publisherName,
        amountVoided: totalAmount,
        voidPayoutAmount: payoutAmount,
        voidConversionAmount: conversionAmount,
      });
      await voidCall(inboundCallId, { payoutAmount, conversionAmount });
      voidSucceeded = true;

      logTaskStep("VOID_SUCCESS", {
        inboundCallId,
        taskId: jobId,
        publisherName,
        amountVoided: totalAmount,
        voidPayoutAmount: payoutAmount,
        voidConversionAmount: conversionAmount,
      });

      try {
        await runApproveWithZeroConversionRetry(
          jobId,
          { amountConversion: 0, amountPayout: 0 },
          { inboundCallId, taskId: jobId, publisherName }
        );

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
      } catch (approveError) {
        if (approveError instanceof RingbaAuthError) {
          const { message } = classifyScrubError(approveError);
          logTaskStep("AUTH_ABORT", {
            inboundCallId,
            taskId: jobId,
            publisherName,
            amountVoided: 0,
            errorMessage: message,
          });
          result.authFailure = true;
          return result;
        }

        recordError(inboundCallId, approveError);
        logApproveFailureAfterVoid(
          {
            inboundCallId,
            taskId: jobId,
            publisherName,
            totalAmount,
            payoutAmount,
            conversionAmount,
          },
          approveError
        );
        result.errors += 1;
      }

      if (callDelayMs > 0) {
        await sleep(callDelayMs);
      }
    } catch (error) {
      if (error instanceof RingbaAuthError) {
        const { message } = classifyScrubError(error);
        logTaskStep("AUTH_ABORT", {
          inboundCallId,
          taskId: jobId,
          publisherName,
          amountVoided: 0,
          errorMessage: message,
        });
        result.authFailure = true;
        return result;
      }

      if (!voidSucceeded && isConversionAlreadyAtZeroVoidError(error)) {
        const { message: voidFailMessage } = classifyScrubError(error);
        logTaskStep("VOID_FAILED", {
          inboundCallId,
          taskId: jobId,
          publisherName,
          errorMessage: voidFailMessage,
        });
        console.log(
          `[ScrubAgent] VOID SKIPPED (conversion already zero), approving task ${publisherName}`
        );
        try {
          await runApproveWithZeroConversionRetry(
            jobId,
            { amountConversion: 0, amountPayout: 0 },
            { inboundCallId, taskId: jobId, publisherName }
          );

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
        } catch (approveError) {
          if (approveError instanceof RingbaAuthError) {
            const { message } = classifyScrubError(approveError);
            logTaskStep("AUTH_ABORT", {
              inboundCallId,
              taskId: jobId,
              publisherName,
              amountVoided: 0,
              errorMessage: message,
            });
            result.authFailure = true;
            return result;
          }

          recordError(inboundCallId, approveError);
          logApproveFailureAfterVoid(
            {
              inboundCallId,
              taskId: jobId,
              publisherName,
              totalAmount,
              payoutAmount,
              conversionAmount,
            },
            approveError
          );
          result.errors += 1;
        }

        if (callDelayMs > 0) {
          await sleep(callDelayMs);
        }
        continue;
      }

      const { message } = classifyScrubError(error);
      recordError(inboundCallId, error);

      if (voidSucceeded) {
        logApproveFailureAfterVoid(
          {
            inboundCallId,
            taskId: jobId,
            publisherName,
            totalAmount,
            payoutAmount,
            conversionAmount,
          },
          error
        );
      } else {
        logTaskStep("VOID_FAILED", {
          inboundCallId,
          taskId: jobId,
          publisherName,
          errorMessage: message,
        });
        logScrub({
          inboundCallId,
          publisherName,
          amountVoided: null,
          status: "error",
          errorMessage: message,
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

import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://api.ringba.com/v2";
const JQI_PREFIX = "JQI_";

interface JobQueItem {
  id?: string;
  status?: string;
  type?: string;
  title?: string;
  job_details?: string;
  public_state?: Record<string, { value?: unknown }>;
  [key: string]: unknown;
}

interface JobsResponse {
  jobs?: JobQueItem[];
  [key: string]: unknown;
}

function isConversionAdjustmentJob(job: JobQueItem): boolean {
  const type = String(job.type ?? "").toLowerCase();
  const title = String(job.title ?? "").toLowerCase();
  const combined = `${type} ${title}`;
  return (
    combined.includes("conversion") && combined.includes("adjust") ||
    combined.includes("conversionadjustment") ||
    combined.includes("adjust conversion")
  );
}

function parseInboundCallIdFromJobId(jobId: string): string | null {
  if (jobId.startsWith(JQI_PREFIX) && jobId.length > JQI_PREFIX.length) {
    return jobId.slice(JQI_PREFIX.length);
  }
  return null;
}

function findInboundCallIdInValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && value.startsWith("RGB")) {
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of [
      "inboundCallId",
      "inbound_call_id",
      "InboundCallId",
    ]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    for (const v of Object.values(obj)) {
      const found = findInboundCallIdInValue(v);
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInboundCallIdInValue(item);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function extractInboundCallId(job: JobQueItem): {
  inboundCallId: string | null;
  source: string;
} {
  const jobId = String(job.id ?? "").trim();
  const fromId = jobId ? parseInboundCallIdFromJobId(jobId) : null;
  if (fromId) {
    return { inboundCallId: fromId, source: "id (JQI_ prefix)" };
  }

  if (job.public_state && typeof job.public_state === "object") {
    for (const [key, entry] of Object.entries(job.public_state)) {
      const fromState = findInboundCallIdInValue(entry?.value ?? entry);
      if (fromState) {
        return {
          inboundCallId: fromState,
          source: `public_state.${key}`,
        };
      }
      if (key.toLowerCase().includes("inboundcall") && entry?.value) {
        const v = String(entry.value).trim();
        if (v.startsWith("RGB")) {
          return { inboundCallId: v, source: `public_state.${key}` };
        }
      }
    }
  }

  if (job.job_details) {
    try {
      const parsed = JSON.parse(job.job_details) as unknown;
      const fromDetails = findInboundCallIdInValue(parsed);
      if (fromDetails) {
        return { inboundCallId: fromDetails, source: "job_details (JSON)" };
      }
    } catch {
      const match = job.job_details.match(/RGB[A-F0-9]+/i);
      if (match) {
        return {
          inboundCallId: match[0],
          source: "job_details (regex)",
        };
      }
    }
  }

  return { inboundCallId: null, source: "not found" };
}

function extractAmountHints(job: JobQueItem): Record<string, unknown> {
  const hints: Record<string, unknown> = {};

  const amountKeyPattern =
    /payout|conversion|revenue|amount|adjust/i;

  if (job.public_state) {
    for (const [key, entry] of Object.entries(job.public_state)) {
      if (amountKeyPattern.test(key)) {
        hints[`public_state.${key}`] = entry?.value ?? entry;
      }
    }
  }

  if (job.job_details) {
    try {
      const parsed = JSON.parse(job.job_details) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (amountKeyPattern.test(key)) {
          hints[`job_details.${key}`] = value;
        }
      }
    } catch {
      // ignore non-JSON job_details
    }
  }

  return hints;
}

/** Read-only probe of Ringba jobQueue for conversion adjustment tasks. */
export async function queueTest(): Promise<void> {
  const token = process.env.RINGBA_API_TOKEN;
  const accountId = process.env.RINGBA_ACCOUNT_ID;

  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }

  const url = `${BASE_URL}/${accountId}/jobQueue`;

  console.log("[queue:test] GET", url);
  const response = await axios.get<JobsResponse>(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
    validateStatus: () => true,
  });

  console.log(
    `[queue:test] HTTP ${response.status} ${response.statusText}\n`
  );
  console.log("[queue:test] Full raw response:");
  console.log(JSON.stringify(response.data, null, 2));

  if (response.status < 200 || response.status >= 300) {
    process.exit(1);
  }

  const allJobs = response.data?.jobs ?? [];
  console.log(`\n[queue:test] Total jobs in response: ${allJobs.length}`);

  const conversionJobs = allJobs.filter(isConversionAdjustmentJob);
  console.log(
    `[queue:test] Open conversion adjustment tasks (type/title match): ${conversionJobs.length}\n`
  );

  for (const job of conversionJobs) {
    const jobId = String(job.id ?? "—");
    const { inboundCallId, source } = extractInboundCallId(job);
    const amounts = extractAmountHints(job);

    console.log("[queue:test] ---");
    console.log(`  jobId: ${jobId}`);
    console.log(`  inboundCallId: ${inboundCallId ?? "—"} (${source})`);
    console.log(`  status: ${job.status ?? "—"}`);
    console.log(`  type: ${job.type ?? "—"}`);
    console.log(`  title: ${job.title ?? "—"}`);
    if (Object.keys(amounts).length > 0) {
      console.log("  amounts:", JSON.stringify(amounts, null, 2));
    } else {
      console.log("  amounts: (none found in public_state / job_details)");
    }
  }

  console.log(
    `\n[queue:test] Total conversion adjustment tasks: ${conversionJobs.length}`
  );
}

void queueTest().catch((error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.data) {
    console.error(
      "[queue:test] Error response:",
      JSON.stringify(error.response.data, null, 2)
    );
  } else {
    console.error(
      "[queue:test] Error:",
      error instanceof Error ? error.message : error
    );
  }
  process.exit(1);
});

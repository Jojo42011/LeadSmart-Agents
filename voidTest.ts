import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://api.ringba.com/v2";
const TEST_INBOUND_CALL_ID =
  "RGB31583525D84BFA567436AC06BEA7C087D4EE8763V3T1-01";

/** One-off void against a fixed call ID; requires DRY_RUN=false. */
export async function voidTest(): Promise<void> {
  const dryRun = process.env.DRY_RUN?.toLowerCase();
  if (dryRun !== "false") {
    console.log(
      "[void:test] Skipped — set DRY_RUN=false in .env to run a live void"
    );
    process.exit(0);
  }

  const token = process.env.RINGBA_API_TOKEN;
  const accountId = process.env.RINGBA_ACCOUNT_ID;

  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }

  const payload = {
    inboundCallId: TEST_INBOUND_CALL_ID,
    voidReason: "void:test script — conversion-only void test",
    voidConversion: true,
    voidConverionAmount: 15,
  };

  const url = `${BASE_URL}/${accountId}/calls/void`;

  console.log("[void:test] Sending void request...");
  console.log(`[void:test] POST ${url}`);
  console.log("[void:test] Payload:", JSON.stringify(payload, null, 2));

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
    validateStatus: () => true,
  });

  console.log(
    `[void:test] Response received — HTTP ${response.status} ${response.statusText}`
  );
  console.log(JSON.stringify(response.data, null, 2));

  if (response.status < 200 || response.status >= 300) {
    process.exit(1);
  }
}

void voidTest().catch((error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.data) {
    console.error(JSON.stringify(error.response.data, null, 2));
  } else {
    console.error(
      "[void:test] Error:",
      error instanceof Error ? error.message : error
    );
  }
  process.exit(1);
});

import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://api.ringba.com/v2";

/** Every exported function must have a JSDoc comment. */
export async function findCall(): Promise<void> {
  const token = process.env.RINGBA_API_TOKEN;
  const accountId = process.env.RINGBA_ACCOUNT_ID;

  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }

  const body = {
    InboundCallIds: ["RGB55649CFA281E537373A83321FE7CC96D569BACD5RGB3102"],
  } as const;

  const response = await axios.post(
    `${BASE_URL}/${accountId}/calllogs/detail`,
    body,
    {
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    }
  );

  // Log the complete raw response body (no filtering / no truncation).
  console.log(JSON.stringify(response.data, null, 2));
}

void findCall().catch((error: unknown) => {
  console.error(
    "[findCall] Error:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});


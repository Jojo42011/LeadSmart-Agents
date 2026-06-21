import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://api.ringba.com/v2";

/** Top 5 publishers by payout from Insights (Jun 2026 payment dashboard). */
const INSIGHTS_TEST_PUBLISHER_NAMES = [
  "Ramzan Ali - GMB",
  "Hoddled",
  "Muhammad Waseem - MP+",
  "Ansar Abbas - Marketplace Allowed Only",
  "Matt Versteeg - Sales Magician",
] as const;

function extractAffiliateItems(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    return [];
  }

  const root = data as Record<string, unknown>;
  const candidates = [
    root.affiliates,
    root.Affiliates,
    root.items,
    root.results,
    root.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function itemHasEmail(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }

  const record = item as Record<string, unknown>;
  const keys = ["email", "Email", "emailAddress", "EmailAddress"];

  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return true;
    }
  }

  return false;
}

function affiliateName(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const record = item as Record<string, unknown>;
  return String(record.name ?? record.Name ?? "").trim();
}

function hasNonEmptyUserIds(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const userIds = (item as Record<string, unknown>).userIds;
  return Array.isArray(userIds) && userIds.length > 0;
}

/** One-time probe of Ringba GET /Affiliates response shape. */
export async function testAffiliates(): Promise<void> {
  const token = process.env.RINGBA_API_TOKEN;
  const accountId = process.env.RINGBA_ACCOUNT_ID;

  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }

  const url = `${BASE_URL}/${accountId}/Affiliates`;
  console.log(`[testAffiliates] GET ${url}`);

  const response = await axios.get<unknown>(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 120_000,
  });

  console.log(`[testAffiliates] HTTP ${response.status}`);
  console.log("[testAffiliates] Full response body:");
  console.log(JSON.stringify(response.data, null, 2));

  const items = extractAffiliateItems(response.data);
  console.log(`\n[testAffiliates] Parsed affiliate count: ${items.length}`);

  const firstThree = items.slice(0, 3);
  console.log("\n[testAffiliates] First 3 items:");
  console.log(JSON.stringify(firstThree, null, 2));

  const withEmail = items.filter(itemHasEmail);
  console.log(
    `\n[testAffiliates] Items with email field: ${withEmail.length} / ${items.length}`
  );

  if (withEmail.length > 0) {
    console.log("[testAffiliates] Sample item with email (first match):");
    console.log(JSON.stringify(withEmail[0], null, 2));
  } else if (items.length > 0) {
    console.log(
      "[testAffiliates] No email field found on any item. Top-level keys on first item:"
    );
    console.log(Object.keys(items[0] as object).join(", "));
  }

  const withUserIds = items.filter(hasNonEmptyUserIds);
  console.log(
    `\n[testAffiliates] Affiliates with non-empty userIds: ${withUserIds.length} / ${items.length}`
  );

  const affiliateNames = new Set(
    items.map(affiliateName).filter((name) => name.length > 0)
  );
  console.log("\n[testAffiliates] Insights name cross-reference (exact match on Affiliates.name):");
  for (const insightsName of INSIGHTS_TEST_PUBLISHER_NAMES) {
    const matched = affiliateNames.has(insightsName);
    console.log(
      `  ${matched ? "MATCH" : "NO MATCH"} — "${insightsName}"`
    );
  }
}

void testAffiliates().catch((error: unknown) => {
  if (axios.isAxiosError(error)) {
    console.error(
      "[testAffiliates] Request failed:",
      error.response?.status,
      JSON.stringify(error.response?.data, null, 2) ?? error.message
    );
  } else if (error instanceof Error) {
    console.error("[testAffiliates] Error:", error.message);
  } else {
    console.error("[testAffiliates] Error:", error);
  }
  process.exit(1);
});

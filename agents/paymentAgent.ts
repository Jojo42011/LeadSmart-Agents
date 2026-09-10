import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { parse } from "csv-parse/sync";
import { getAllAffiliateMetadata } from "../lib/logger";

const BASE_URL = "https://api.ringba.com/v2";
const POLYARES_BASE_URL = "https://affiliates.polyares.com";
const POLYARES_LOGIN_URL = `${POLYARES_BASE_URL}/login`;
const POLYARES_USERNAME = "matthew@leadsmartinc.com";
const POLYARES_PASSWORD = "matthew@leadsmartinc.com";
const POLYARES_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const POLYARES_HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type PaymentSource = "RINGBA" | "POLYERAS";
export type MergedPaymentSource = PaymentSource | "BOTH";

export interface PublisherPayoutRow {
  publisherName: string;
  payoutAmount: number;
  source: PaymentSource;
  callCount?: number;
  convertedCalls?: number;
  completedCalls?: number;
  cplAffiliate?: boolean;
  /** Stable affiliate ID from the Polyares CSV "Source" column (e.g. safderygd1). */
  polyaresId?: string;
  /** Ringba's publisher record ID (AF…). Identity survives a name change. */
  publisherId?: string;
}

export interface PublisherProfitRow {
  publisherName: string;
  payoutAmount: number;
  telcoCost: number;
  callCount: number;
  netProfit: number;
}

export interface MergedPublisherRow {
  publisherName: string;
  ringbaAmount: number;
  polyaresAmount: number;
  totalAmount: number;
  source: MergedPaymentSource;
  callCount?: number;
  convertedCalls?: number;
  completedCalls?: number;
  cplAffiliate?: boolean;
}

export interface PaymentOutlier {
  polyaresName: string;
  polyaresAmount: number;
  similarRingbaName: string;
  ringbaAmount: number;
}

export interface MergeAffiliatesResult {
  publishers: MergedPublisherRow[];
  outliers: PaymentOutlier[];
}

/**
 * Case-insensitive name key. Whitespace runs collapse to a single space and
 * edges are trimmed: the Polyares CSV ships names like "Safdar  Awan " (double
 * internal space + trailing space) that must match Ringba's "Safdar Awan …".
 */
function normalizePublisherName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalized Polyares Source ID ("safderygd1") for map keys. */
function normalizePolyaresId(id: string | null | undefined): string | null {
  const cleaned = String(id ?? "").trim().toLowerCase();
  return cleaned || null;
}

/** @deprecated Link the Polyares Source ID in the affiliate edit popup instead. */
const FORCE_BOTH_MERGE: Record<string, string> = {
  "dominik mikula": "DOMINIK MIKULA AND COMPANY LTD",
  "muhammad bilal2": "Muhammad Bilal2 LSW - N",
};

function isRingbaSuffixTagMatch(polyName: string, ringbaName: string): boolean {
  const poly = normalizePublisherName(polyName);
  const ringba = normalizePublisherName(ringbaName);
  if (poly === ringba) {
    return false;
  }
  if (!ringba.startsWith(poly)) {
    return false;
  }
  return ringba.slice(poly.length).startsWith(" -");
}

function isSimilarNameMatch(polyName: string, ringbaName: string): boolean {
  const poly = normalizePublisherName(polyName);
  const ringba = normalizePublisherName(ringbaName);
  if (poly === ringba) {
    return false;
  }
  if (isRingbaSuffixTagMatch(polyName, ringbaName)) {
    return false;
  }
  if (!ringba.startsWith(poly)) {
    return false;
  }
  const nextChar = ringba[poly.length];
  return nextChar === undefined || /[\s\-–—|/,(]/.test(nextChar);
}

function findSuffixTagRingbaMatch(
  polyName: string,
  ringbaRows: PublisherPayoutRow[]
): PublisherPayoutRow | null {
  const matches = ringbaRows.filter((row) =>
    isRingbaSuffixTagMatch(polyName, row.publisherName)
  );

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.payoutAmount - a.payoutAmount);
  return matches[0];
}

function findPartialRingbaMatch(
  polyName: string,
  ringbaRows: PublisherPayoutRow[]
): PublisherPayoutRow | null {
  const polyNorm = normalizePublisherName(polyName);
  const matches = ringbaRows.filter((row) =>
    isSimilarNameMatch(polyName, row.publisherName)
  );

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => {
    const aContains = normalizePublisherName(a.publisherName).includes(polyNorm)
      ? 1
      : 0;
    const bContains = normalizePublisherName(b.publisherName).includes(polyNorm)
      ? 1
      : 0;
    if (bContains !== aContains) {
      return bContains - aContains;
    }
    return b.payoutAmount - a.payoutAmount;
  });

  return matches[0];
}

/**
 * Polyares Source ID → dashboard publisher name, from affiliate_metadata.
 * Set from the affiliate edit popup; this is the durable merge key that
 * replaces name matching (and the FORCE_BOTH_MERGE hardcodes) over time.
 */
function polyaresIdMapFromMetadata(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const metadata = getAllAffiliateMetadata();
    for (const [publisherName, meta] of Object.entries(metadata)) {
      const polyId = normalizePolyaresId(meta.polyaresId);
      if (polyId) {
        map.set(polyId, publisherName);
      }
    }
  } catch (err) {
    console.warn(
      "[PaymentAgent] Could not load Polyares ID map — falling back to name matching:",
      err instanceof Error ? err.message : err
    );
  }
  return map;
}

/**
 * Merges Ringba and Polyares payout rows. Primary key: the Polyares Source ID
 * mapped via affiliate_metadata.polyaresId (immune to name drift). Fallback:
 * exact name or Ringba suffix-tag name (whitespace-normalized on both sides).
 * Ambiguous partial matches are flagged in outliers for manual review.
 */
export function mergeAffiliates(
  ringbaRows: PublisherPayoutRow[],
  polyaresRows: PublisherPayoutRow[],
  polyaresIdMap: Map<string, string> = polyaresIdMapFromMetadata()
): MergeAffiliatesResult {
  const ringbaByKey = new Map<string, PublisherPayoutRow>();
  for (const row of ringbaRows) {
    ringbaByKey.set(normalizePublisherName(row.publisherName), row);
  }

  const publishers: MergedPublisherRow[] = ringbaRows.map((row) => ({
    publisherName: row.publisherName,
    ringbaAmount: row.payoutAmount,
    polyaresAmount: 0,
    totalAmount: row.payoutAmount,
    source: "RINGBA",
    callCount: row.callCount,
    convertedCalls: row.convertedCalls,
    completedCalls: row.completedCalls,
    ...(row.cplAffiliate ? { cplAffiliate: true } : {}),
  }));

  const publisherIndexByKey = new Map<string, number>();
  for (let i = 0; i < publishers.length; i++) {
    publisherIndexByKey.set(normalizePublisherName(publishers[i].publisherName), i);
  }

  const outliers: PaymentOutlier[] = [];

  for (const polyRow of polyaresRows) {
    const key = normalizePublisherName(polyRow.publisherName);
    const ringbaRow = ringbaByKey.get(key);
    const existingIndex = publisherIndexByKey.get(key);

    // Primary path — stable Polyares Source ID linked in affiliate metadata.
    // Merges regardless of how the two platforms spell the name.
    const polyId = normalizePolyaresId(polyRow.polyaresId);
    const mappedPublisher = polyId ? polyaresIdMap.get(polyId) : undefined;
    if (mappedPublisher) {
      const mappedKey = normalizePublisherName(mappedPublisher);
      const mappedIndex = publisherIndexByKey.get(mappedKey);
      if (mappedIndex !== undefined) {
        const existing = publishers[mappedIndex];
        publishers[mappedIndex] = {
          ...existing,
          polyaresAmount: existing.polyaresAmount + polyRow.payoutAmount,
          totalAmount:
            existing.ringbaAmount +
            existing.polyaresAmount +
            polyRow.payoutAmount,
          source: "BOTH",
        };
      } else {
        // No Ringba activity this period — still surface under the canonical
        // dashboard name so metadata/payment method line up.
        publishers.push({
          publisherName: mappedPublisher,
          ringbaAmount: 0,
          polyaresAmount: polyRow.payoutAmount,
          totalAmount: polyRow.payoutAmount,
          source: "POLYERAS",
        });
        publisherIndexByKey.set(mappedKey, publishers.length - 1);
      }
      continue;
    }

    if (ringbaRow && existingIndex !== undefined) {
      const existing = publishers[existingIndex];
      publishers[existingIndex] = {
        publisherName: ringbaRow.publisherName,
        ringbaAmount: existing.ringbaAmount,
        polyaresAmount: polyRow.payoutAmount,
        totalAmount: existing.ringbaAmount + polyRow.payoutAmount,
        source: "BOTH",
        callCount: ringbaRow.callCount,
        convertedCalls: ringbaRow.convertedCalls,
        completedCalls: ringbaRow.completedCalls,
        ...(ringbaRow.cplAffiliate ? { cplAffiliate: true } : {}),
      };
      continue;
    }

    const forcedRingbaName = FORCE_BOTH_MERGE[key];
    if (forcedRingbaName) {
      const forcedRingba = ringbaByKey.get(normalizePublisherName(forcedRingbaName));
      const forcedIndex = publisherIndexByKey.get(normalizePublisherName(forcedRingbaName));
      if (forcedRingba && forcedIndex !== undefined) {
        const existing = publishers[forcedIndex];
        publishers[forcedIndex] = {
          publisherName: forcedRingba.publisherName,
          ringbaAmount: existing.ringbaAmount,
          polyaresAmount: existing.polyaresAmount + polyRow.payoutAmount,
          totalAmount: existing.ringbaAmount + existing.polyaresAmount + polyRow.payoutAmount,
          source: "BOTH",
          callCount: forcedRingba.callCount,
          convertedCalls: forcedRingba.convertedCalls,
          completedCalls: forcedRingba.completedCalls,
          ...(forcedRingba.cplAffiliate ? { cplAffiliate: true } : {}),
        };
        continue;
      }
    }

    const suffixTagRingba = findSuffixTagRingbaMatch(
      polyRow.publisherName,
      ringbaRows
    );
    if (suffixTagRingba) {
      const suffixKey = normalizePublisherName(suffixTagRingba.publisherName);
      const suffixIndex = publisherIndexByKey.get(suffixKey);
      if (suffixIndex !== undefined) {
        const existing = publishers[suffixIndex];
        publishers[suffixIndex] = {
          publisherName: suffixTagRingba.publisherName,
          ringbaAmount: existing.ringbaAmount,
          polyaresAmount: existing.polyaresAmount + polyRow.payoutAmount,
          totalAmount: existing.ringbaAmount + existing.polyaresAmount + polyRow.payoutAmount,
          source: "BOTH",
          callCount: suffixTagRingba.callCount,
          convertedCalls: suffixTagRingba.convertedCalls,
          completedCalls: suffixTagRingba.completedCalls,
          ...(suffixTagRingba.cplAffiliate ? { cplAffiliate: true } : {}),
        };
        continue;
      }
    }

    publishers.push({
      publisherName: polyRow.publisherName,
      ringbaAmount: 0,
      polyaresAmount: polyRow.payoutAmount,
      totalAmount: polyRow.payoutAmount,
      source: "POLYERAS",
    });

    const similarRingba = findPartialRingbaMatch(
      polyRow.publisherName,
      ringbaRows
    );
    if (similarRingba) {
      outliers.push({
        polyaresName: polyRow.publisherName,
        polyaresAmount: polyRow.payoutAmount,
        similarRingbaName: similarRingba.publisherName,
        ringbaAmount: similarRingba.payoutAmount,
      });
    }
  }

  publishers.sort((a, b) => b.totalAmount - a.totalAmount);

  return { publishers, outliers };
}

function getAccountId(): string {
  const accountId = process.env.RINGBA_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }
  return accountId;
}

function getApiToken(): string {
  const token = process.env.RINGBA_API_TOKEN;
  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  return token;
}

function createClient(): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Token ${getApiToken()}`,
      "Content-Type": "application/json",
    },
    timeout: 120_000,
  });
}

const CHICAGO_TZ = "America/Chicago";

/** Format an ISO instant as MM/DD/YYYY in Chicago (matches monthToDateRange in server.ts). */
function isoToChicagoMdY(isoDate: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoDate));
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("month")}/${read("day")}/${read("year")}`;
}

function aggregatePolyaresRows(rows: PublisherPayoutRow[]): PublisherPayoutRow[] {
  const byKey = new Map<string, PublisherPayoutRow>();

  for (const row of rows) {
    // Group by the stable Source ID when present (two rows with the same
    // display name but different IDs are DIFFERENT affiliates); fall back to
    // the whitespace-normalized name.
    const polyId = normalizePolyaresId(row.polyaresId);
    const key = polyId ? `id:${polyId}` : `name:${normalizePublisherName(row.publisherName)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.payoutAmount += row.payoutAmount;
      continue;
    }
    byKey.set(key, { ...row });
  }

  return Array.from(byKey.values()).sort((a, b) => b.payoutAmount - a.payoutAmount);
}

function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isNaN(num) ? 0 : num;
}

/**
 * First present numeric field among `keys`, or null when none is usable.
 *
 * CPL detection MUST distinguish "amount is genuinely zero" from "Ringba did
 * not return the column" — parseNumber() maps both to 0, which made every CPL
 * group look unfinalized and pinned the CPL badge permanently (observed: 106
 * affiliates still tagged for June, months after those amounts settled).
 */
function readOptionalNumber(
  raw: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const num = typeof value === "number" ? value : parseFloat(String(value));
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  return null;
}

function rowFromColumns(
  columns: Array<{ column?: string; name?: string; value?: unknown }>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    const key = col.column ?? col.name;
    if (key) {
      row[key] = col.value;
    }
  }
  return row;
}

function extractRawRows(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const root = data as Record<string, unknown>;
  const report = root.report as Record<string, unknown> | undefined;

  const candidates: unknown[] = [];

  if (report) {
    candidates.push(report.records, report.rows, report.data);
    const table = report.table as Record<string, unknown> | undefined;
    if (table) {
      candidates.push(table.rows, table.records, table.data);
    }
  }

  candidates.push(root.records, root.rows, root.data);

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const rows: Record<string, unknown>[] = [];
    for (const item of candidate) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.columns)) {
        rows.push(
          rowFromColumns(
            record.columns as Array<{
              column?: string;
              name?: string;
              value?: unknown;
            }>
          )
        );
      } else {
        rows.push(record);
      }
    }

    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

const CPL_TARGET_MARKERS = ["inquirly", "33 miles rtt -"] as const;

function isCplTargetLabel(label: string): boolean {
  const lower = label.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return CPL_TARGET_MARKERS.some((marker) => lower.includes(marker));
}

function targetBuyerLabelFromRow(raw: Record<string, unknown>): string {
  const target = String(
    raw.targetName ?? raw.TargetName ?? raw.target ?? ""
  ).trim();
  const buyer = String(raw.buyer ?? raw.Buyer ?? "").trim();
  // The CPL updater found that in this account the marker often lives in the
  // campaign name rather than target/buyer, so scan it too when present.
  const campaign = String(raw.campaignName ?? raw.CampaignName ?? "").trim();
  return [target, buyer, campaign].filter(Boolean).join(" ");
}

function normalizePublisherRow(
  raw: Record<string, unknown>
): PublisherPayoutRow | null {
  const publisherName = String(
    raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
  ).trim();

  if (!publisherName) {
    return null;
  }

  const publisherId = String(
    raw.publisherId ?? raw.PublisherId ?? raw.publisherID ?? ""
  ).trim();

  return {
    publisherName,
    payoutAmount: parseNumber(raw.payoutAmount),
    source: "RINGBA",
    callCount: parseNumber(raw.callCount),
    convertedCalls: parseNumber(raw.convertedCalls),
    completedCalls: parseNumber(raw.completedCalls),
    ...(publisherId ? { publisherId } : {}),
  };
}

export interface PayoutFetchStats {
  /** Publisher rows Ringba returned for the money query. */
  ringbaRowsFetched: number;
  /** Rows after folding renames — fetched minus rowsFoldedAway must equal this. */
  rowsReturned: number;
  /** Rows absorbed into another row because they share a publisher record. */
  rowsFoldedAway: number;
  /** Names the id lookup could resolve (0 = folding disabled this run). */
  idsResolved: number;
  at: string;
}

let lastPayoutFetchStats: PayoutFetchStats | null = null;

/**
 * Counts from the most recent payout fetch. Surfaced on /api/payment/stats/all
 * so it can be verified from outside that no publisher is silently dropped —
 * an id-grouped money query once removed three affiliates and their $895
 * without a trace, and theory alone could not rule that out afterwards.
 */
export function getLastPayoutFetchStats(): PayoutFetchStats | null {
  return lastPayoutFetchStats;
}

/**
 * publisher name → Ringba publisher record id, for the reporting window.
 *
 * Deliberately a SEPARATE lookup rather than a grouping on the money query:
 * an id-grouped money query omits publishers whose id is null, which silently
 * drops them (and their payout) from the dashboard. Here a missing row only
 * costs us the ability to fold a rename, never the affiliate or their money.
 * Failure is non-fatal — no ids simply means no folding.
 */
async function fetchPublisherIdByName(
  client: AxiosInstance,
  accountId: string,
  baseBody: ReturnType<typeof ringbaInsightsBaseBody>
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  try {
    const res = await client.post<unknown>(`/${accountId}/insights`, {
      ...baseBody,
      groupByColumns: [
        { column: "publisherId", displayName: "Publisher ID" },
        { column: "publisherName", displayName: "Publisher" },
      ],
      valueColumns: [{ column: "callCount", aggregateFunction: null }],
      orderByColumns: [{ column: "callCount", direction: "desc" }],
    });

    for (const raw of extractRawRows(res.data)) {
      const name = String(
        raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
      ).trim();
      const id = String(
        raw.publisherId ?? raw.PublisherId ?? raw.publisherID ?? ""
      ).trim();
      if (name && id) {
        byName.set(normalizePublisherName(name), id);
      }
    }
    console.log(
      "[PaymentAgent] publisher id lookup: %d name(s) resolved",
      byName.size
    );
  } catch (error) {
    console.warn(
      "[PaymentAgent] publisherId lookup unavailable — mid-period renames will stay split:",
      axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data, null, 2)
        : error
    );
  }
  return byName;
}

/** Normalized publisher names that already carry a real payment method. */
function publishersWithPaymentMetadata(): Set<string> {
  const tagged = new Set<string>();
  try {
    for (const [publisherName, meta] of Object.entries(getAllAffiliateMetadata())) {
      if (meta.paymentMethod && meta.paymentMethod !== "Untagged") {
        tagged.add(normalizePublisherName(publisherName));
      }
    }
  } catch (err) {
    console.warn(
      "[PaymentAgent] Could not load metadata for rename merge — falling back to call volume:",
      err instanceof Error ? err.message : err
    );
  }
  return tagged;
}

/**
 * Of several names for one Ringba publisher record, the one to keep.
 *
 * Payment method, Wise/Bill.com IDs and paid-status all key off the publisher
 * NAME, so a rename must land on the name that already carries that metadata —
 * otherwise the affiliate would surface as Untagged and become unpayable.
 * Falls back to the busiest variant when neither name is tagged.
 */
function pickCanonicalRow(
  group: PublisherPayoutRow[],
  taggedNames: Set<string>
): PublisherPayoutRow {
  const tagged = group.filter((row) =>
    taggedNames.has(normalizePublisherName(row.publisherName))
  );
  const pool = tagged.length > 0 ? tagged : group;
  return [...pool].sort(
    (a, b) => (b.callCount ?? 0) - (a.callCount ?? 0)
  )[0];
}

/**
 * Collapses rows that are the SAME Ringba publisher record seen under more
 * than one name — what happens when an affiliate is renamed mid-period, which
 * otherwise splits their calls and money across two dashboard rows.
 *
 * Merging is keyed strictly on Ringba's publisherId. Names are never used:
 * dozens of genuinely separate affiliates share a base name and differ only by
 * a traffic tag ("Syed Hamza Farooq - GMB" vs "- Marketplace"), and combining
 * those would pay one affiliate another's money. Rows without an id are passed
 * through untouched.
 */
export function mergeRenamedPublishers(
  rows: PublisherPayoutRow[],
  taggedNames: Set<string> = publishersWithPaymentMetadata()
): PublisherPayoutRow[] {
  const byId = new Map<string, PublisherPayoutRow[]>();
  const merged: PublisherPayoutRow[] = [];

  for (const row of rows) {
    const id = (row.publisherId ?? "").trim();
    if (!id) {
      merged.push(row);
      continue;
    }
    const group = byId.get(id);
    if (group) {
      group.push(row);
    } else {
      byId.set(id, [row]);
    }
  }

  for (const [publisherId, group] of byId) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    const canonical = pickCanonicalRow(group, taggedNames);
    const sum = (pick: (row: PublisherPayoutRow) => number | undefined) =>
      group.reduce((total, row) => total + (pick(row) ?? 0), 0);

    merged.push({
      ...canonical,
      payoutAmount: sum((row) => row.payoutAmount),
      callCount: sum((row) => row.callCount),
      convertedCalls: sum((row) => row.convertedCalls),
      completedCalls: sum((row) => row.completedCalls),
      ...(group.some((row) => row.cplAffiliate) ? { cplAffiliate: true as const } : {}),
    });

    console.log(
      "[PaymentAgent] Renamed publisher %s: merged [%s] into %s",
      publisherId,
      group.map((row) => row.publisherName).join(" | "),
      canonical.publisherName
    );
  }

  return merged;
}

/**
 * Publishers with CPL calls whose conversion amount is still UNSET. The CPL
 * tag exists to mark money Ringba has not finalized — once the CPL updater
 * writes real amounts onto the calls, the tag (and the HELD state and the
 * PAY ALL exclusion that hang off it) must clear on the next dashboard load.
 *
 * The query behind these rows filters to conversionAmount = 0 server-side, so
 * a surviving group row means un-finalized calls exist. The local amount check
 * is belt-and-suspenders: if Ringba ever ignored the filter, the group would
 * aggregate ALL the publisher's CPL calls and a non-zero sum still means
 * amounts have been applied — either way, a fully-updated affiliate stops
 * tagging as CPL.
 */
interface CplDetection {
  /** Publishers whose CPL money is still unwritten — these get the CPL tag. */
  keys: Set<string>;
  /** CPL-target groups present in the response. */
  cplGroups: number;
  /** Of those, how many carried a usable amount, so we could actually judge. */
  groupsWithAmount: number;
}

/**
 * Publishers whose CPL calls are still UNFINALIZED (Ringba has written no
 * money for them yet).
 *
 * The CPL updater writes payout and revenue together (batch rows go
 * payout/revenue 0 → real amount in one action), so a CPL group still sitting
 * at zero has nothing finalized. The moment any amount lands, the group
 * reports non-zero and the tag clears on the next dashboard load.
 *
 * A group with NO usable amount field is treated as UNKNOWN and never tags.
 * Inferring "unfinalized" from a missing column is exactly what made the badge
 * permanent, so absence of evidence must not become evidence of pending.
 */
export function collectCplPublisherKeys(
  rawRows: Record<string, unknown>[]
): CplDetection {
  const keys = new Set<string>();
  let cplGroups = 0;
  let groupsWithAmount = 0;

  for (const raw of rawRows) {
    if (!isCplTargetLabel(targetBuyerLabelFromRow(raw))) {
      continue;
    }
    if (parseNumber(raw.callCount) <= 0) {
      continue;
    }
    cplGroups += 1;

    // payoutAmount is the money column the insights endpoint is known to
    // return for this account (the main payout query relies on it, and the
    // dashboard renders it). conversionAmount is preferred when present.
    const amount = readOptionalNumber(raw, [
      "conversionAmount",
      "ConversionAmount",
      "payoutAmount",
      "PayoutAmount",
    ]);
    if (amount === null) {
      continue;
    }
    groupsWithAmount += 1;
    if (amount !== 0) {
      continue;
    }

    const publisherName = String(
      raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
    ).trim();
    if (!publisherName) {
      continue;
    }
    keys.add(normalizePublisherName(publisherName));
  }

  return { keys, cplGroups, groupsWithAmount };
}

const CPL_DETECTION_WINDOW_DAYS = 7;

/**
 * CPL calls only matter for the last 7 calendar days of the period — that is the
 * window where Ringba has not finalized amounts (they show as $0). Earlier calls
 * are already settled, so an affiliate with CPL calls only in earlier weeks must
 * not be flagged. For a week-length range this collapses to the whole range.
 */
function cplDetectionWindow(
  startDate: string,
  endDate: string
): { start: string; end: string } {
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const windowStartMs = Math.max(
    startMs,
    endMs - CPL_DETECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  return { start: new Date(windowStartMs).toISOString(), end: endDate };
}

/**
 * Row cap for insights queries.
 *
 * This sat at 1,000 while the account carries ~1,101 publishers, and the money
 * query orders by payout descending — so it returned exactly 1,000 rows and
 * the ~100 SMALLEST payouts were silently truncated. Those affiliates simply
 * never appeared on the payment dashboard and so were never paid (observed:
 * Mudasser Abbas $514.49, Mazhar Hussain2 $204.77, Toseef Nawaz $175.93 all
 * vanished once the publisher count crossed the cap). Headroom matters more
 * than response size here; tunable via RINGBA_INSIGHTS_MAX_ROWS.
 */
function insightsMaxResultsPerGroup(): number {
  const raw = parseInt(process.env.RINGBA_INSIGHTS_MAX_ROWS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

function ringbaInsightsBaseBody(startDate: string, endDate: string) {
  return {
    reportStart: startDate,
    reportEnd: endDate,
    formatTimespans: true,
    formatPercentages: true,
    generateRollups: true,
    maxResultsPerGroup: insightsMaxResultsPerGroup(),
    filters: [] as unknown[],
    formatTimeZone: "America/Chicago",
  };
}

/**
 * Pulls affiliate payout aggregates from Ringba insights for a date range.
 */
export async function fetchPublisherPayouts(
  startDate: string,
  endDate: string
): Promise<PublisherPayoutRow[]> {
  const client = createClient();
  const accountId = getAccountId();
  const baseBody = ringbaInsightsBaseBody(startDate, endDate);

  const payoutBody = {
    ...baseBody,
    groupByColumns: [{ column: "publisherName", displayName: "Publisher" }],
    valueColumns: [
      { column: "callCount", aggregateFunction: null },
      { column: "completedCalls", aggregateFunction: null },
      { column: "convertedCalls", aggregateFunction: null },
      { column: "payoutAmount", aggregateFunction: null },
    ],
    orderByColumns: [{ column: "payoutAmount", direction: "desc" }],
  };

  const cplWindow = cplDetectionWindow(startDate, endDate);
  const cplBody = {
    ...baseBody,
    reportStart: cplWindow.start,
    reportEnd: cplWindow.end,
    groupByColumns: [
      { column: "publisherName", displayName: "Publisher" },
      { column: "targetName", displayName: "Target" },
    ],
    // Money per CPL group so collectCplPublisherKeys can tell finalized from
    // pending. No server-side amount filter: this endpoint rejected one (which
    // silently dropped us into a fallback that tagged every CPL publisher),
    // and the local check does the job without depending on filter support.
    valueColumns: [
      { column: "callCount", aggregateFunction: null },
      { column: "payoutAmount", aggregateFunction: null },
    ],
    orderByColumns: [{ column: "callCount", direction: "desc" }],
  };

  // The name-grouped query stays the authoritative row set. Grouping the money
  // query by publisherId instead would DROP any publisher whose id is null —
  // observed live: three publishers with 66/79/7 calls and $895 between them
  // disappeared from the dashboard entirely, which would mean never paying
  // them. Identity is resolved separately below.
  let payoutResponse;
  try {
    payoutResponse = await client.post<unknown>(
      `/${accountId}/insights`,
      payoutBody
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "[PaymentAgent] Ringba insights error response:",
        JSON.stringify(error.response?.data, null, 2)
      );
    }
    throw error;
  }

  const publisherIdByName = await fetchPublisherIdByName(
    client,
    accountId,
    baseBody
  );

  let cplPublisherKeys = new Set<string>();
  try {
    const cplResponse = await client.post<unknown>(
      `/${accountId}/insights`,
      cplBody
    );
    const detection = collectCplPublisherKeys(extractRawRows(cplResponse.data));
    cplPublisherKeys = detection.keys;

    if (detection.cplGroups > 0 && detection.groupsWithAmount === 0) {
      // The amount column stopped coming back. Tag nobody rather than
      // everybody — this is the exact condition that pinned the badge before.
      console.warn(
        "[PaymentAgent] CPL detection: %d CPL group(s) returned no payout/conversion amount — cannot tell finalized from pending, so tagging nobody. Check the insights valueColumns.",
        detection.cplGroups
      );
    } else {
      console.log(
        "[PaymentAgent] CPL detection: %d CPL group(s), %d with amounts, %d publisher(s) still pending",
        detection.cplGroups,
        detection.groupsWithAmount,
        cplPublisherKeys.size
      );
    }
  } catch (error) {
    // Never blanket-tag on failure: doing that is what held affiliates whose
    // CPL amounts had long since been written.
    console.warn(
      "[PaymentAgent] CPL insights failed — continuing without CPL flags:",
      axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data, null, 2)
        : error
    );
  }

  const tagged = extractRawRows(payoutResponse.data)
    .map(normalizePublisherRow)
    .filter((row): row is PublisherPayoutRow => row !== null)
    .map((row) => {
      const key = normalizePublisherName(row.publisherName);
      const publisherId = publisherIdByName.get(key);
      const withId = publisherId ? { ...row, publisherId } : row;
      if (!cplPublisherKeys.has(key)) {
        return withId;
      }
      return { ...withId, cplAffiliate: true as const };
    });

  // CPL flags are applied per name first, then folded together, so a rename
  // cannot drop the flag when it was only recorded under the other name.
  const rows = mergeRenamedPublishers(tagged);

  lastPayoutFetchStats = {
    ringbaRowsFetched: tagged.length,
    rowsReturned: rows.length,
    rowsFoldedAway: tagged.length - rows.length,
    idsResolved: publisherIdByName.size,
    at: new Date().toISOString(),
  };
  console.log(
    "[PaymentAgent] payout rows: %d fetched, %d folded as renames, %d returned (%d ids resolved)",
    tagged.length,
    tagged.length - rows.length,
    rows.length,
    publisherIdByName.size
  );

  rows.sort((a, b) => b.payoutAmount - a.payoutAmount);

  return rows;
}

function normalizeProfitRow(
  raw: Record<string, unknown>
): PublisherProfitRow | null {
  const publisherName = String(
    raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
  ).trim();

  if (!publisherName) {
    return null;
  }

  const payoutAmount = parseNumber(raw.payoutAmount);
  const telcoCost = parseNumber(raw.telcoCost);
  const callCount = parseNumber(raw.callCount);

  if (payoutAmount === 0 && telcoCost === 0) {
    return null;
  }

  return {
    publisherName,
    payoutAmount,
    telcoCost,
    callCount,
    netProfit: payoutAmount - telcoCost,
  };
}

/**
 * Pulls per-publisher payout, telco cost, and net profit from Ringba insights.
 */
export async function fetchPublisherProfitData(
  startDate: string,
  endDate: string
): Promise<PublisherProfitRow[]> {
  const client = createClient();
  const accountId = getAccountId();

  const body = {
    reportStart: startDate,
    reportEnd: endDate,
    groupByColumns: [{ column: "publisherName" }],
    valueColumns: [
      { column: "payoutAmount", aggregateFunction: null },
      { column: "telcoCost", aggregateFunction: null },
      { column: "callCount", aggregateFunction: null },
    ],
    orderByColumns: [{ column: "telcoCost", direction: "desc" }],
    formatTimespans: true,
    formatPercentages: true,
    generateRollups: true,
    // Same truncation risk as the payout query — the publisher profit view
    // would quietly lose its tail once the account passes the cap.
    maxResultsPerGroup: insightsMaxResultsPerGroup(),
    filters: [],
    formatTimeZone: "America/Chicago",
  };

  let response;
  try {
    response = await client.post<unknown>(`/${accountId}/insights`, body);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "[PaymentAgent] Ringba profit insights error response:",
        JSON.stringify(error.response?.data, null, 2)
      );
    }
    throw error;
  }

  const rows = extractRawRows(response.data)
    .map(normalizeProfitRow)
    .filter((row): row is PublisherProfitRow => row !== null);

  rows.sort((a, b) => b.telcoCost - a.telcoCost);

  return rows;
}

const RENTAL_COST_PER_NUMBER = 1;

function findNumbersCsvPublisherColumn(columns: string[]): string | null {
  for (const column of columns) {
    const normalized = column.trim().toLowerCase().replace(/\s+/g, " ");
    if (
      normalized === "publisher name" ||
      normalized === "publishername" ||
      normalized === "publisher"
    ) {
      return column;
    }
  }
  return null;
}

/**
 * Parses a Ringba numbers CSV and counts rows per publisher.
 * Keys are normalized publisher names.
 */
export function parseNumbersCSV(csvText: string): Record<string, number> {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    return {};
  }

  const publisherColumn = findNumbersCsvPublisherColumn(
    Object.keys(records[0] ?? {})
  );
  if (!publisherColumn) {
    throw new Error('CSV must include a "Publisher Name" column');
  }

  const counts: Record<string, number> = {};
  for (const record of records) {
    const publisherName = String(record[publisherColumn] ?? "").trim();
    if (!publisherName) {
      continue;
    }
    const key = normalizePublisherName(publisherName);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

export function rentalCostsFromNumberCounts(
  counts: Record<string, number>
): Record<string, number> {
  const rentalCosts: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    rentalCosts[key] = count * RENTAL_COST_PER_NUMBER;
  }
  return rentalCosts;
}

function createPolyaresClient(jar: CookieJar) {
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 120_000,
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
      },
    })
  );
}

function logPolyaresStep(step: string, details: Record<string, unknown>): void {
  console.log(
    `[PaymentAgent] Polyares ${step}:`,
    JSON.stringify(details, null, 2)
  );
}

interface LoginFormInput {
  name: string;
  type: string;
  value: string;
}

interface ParsedLoginForm {
  actionUrl: string;
  formActionRaw: string | null;
  inputs: LoginFormInput[];
  hiddenFields: Record<string, string>;
  usesYii2LoginForm: boolean;
}

function resolvePolyaresUrl(action: string | null | undefined): string {
  if (!action || action === "") {
    return POLYARES_LOGIN_URL;
  }
  if (action.startsWith("http://") || action.startsWith("https://")) {
    return action;
  }
  if (action.startsWith("/")) {
    return `${POLYARES_BASE_URL}${action}`;
  }
  return `${POLYARES_BASE_URL}/${action}`;
}

function parseInputTag(tag: string): LoginFormInput | null {
  const nameMatch = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
  if (!nameMatch) {
    return null;
  }

  const typeMatch = tag.match(/\btype\s*=\s*["']([^"']+)["']/i);
  const valueMatch = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);

  return {
    name: nameMatch[1],
    type: typeMatch ? typeMatch[1].toLowerCase() : "text",
    value: valueMatch ? valueMatch[1] : "",
  };
}

function parseLoginForm(html: string): ParsedLoginForm {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? [];

  for (const form of forms) {
    if (!/<input\b[^>]*type\s*=\s*["']password["']/i.test(form)) {
      continue;
    }

    const actionMatch = form.match(
      /<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i
    );
    const formActionRaw = actionMatch ? actionMatch[1] : "";
    const actionUrl = resolvePolyaresUrl(formActionRaw);

    const inputs: LoginFormInput[] = [];
    const hiddenFields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = inputRe.exec(form)) !== null) {
      const parsed = parseInputTag(match[0]);
      if (!parsed) {
        continue;
      }

      inputs.push(parsed);
      if (parsed.type === "hidden") {
        hiddenFields[parsed.name] = parsed.value;
      }
    }

    const usesYii2LoginForm = inputs.some(
      (input) =>
        input.name === "LoginForm[email]" ||
        input.name === "LoginForm[password]"
    );

    return {
      actionUrl,
      formActionRaw: formActionRaw || null,
      inputs,
      hiddenFields,
      usesYii2LoginForm,
    };
  }

  return {
    actionUrl: POLYARES_LOGIN_URL,
    formActionRaw: null,
    inputs: [],
    hiddenFields: extractHiddenFieldsFromHtml(html),
    usesYii2LoginForm: html.includes("LoginForm[email]"),
  };
}

function extractHiddenFieldsFromHtml(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = inputRe.exec(html)) !== null) {
    const parsed = parseInputTag(match[0]);
    if (!parsed || parsed.type !== "hidden") {
      continue;
    }
    fields[parsed.name] = parsed.value;
  }

  return fields;
}

function buildPolyaresLoginBody(parsedForm: ParsedLoginForm): URLSearchParams {
  const loginBody = new URLSearchParams();

  for (const [name, value] of Object.entries(parsedForm.hiddenFields)) {
    loginBody.set(name, value);
  }

  if (parsedForm.usesYii2LoginForm) {
    loginBody.set("LoginForm[email]", POLYARES_USERNAME);
    loginBody.set("LoginForm[password]", POLYARES_PASSWORD);
    return loginBody;
  }

  const usernameField = parsedForm.inputs.find(
    (input) =>
      input.type === "text" ||
      input.type === "email" ||
      input.name.toLowerCase().includes("user") ||
      input.name.toLowerCase().includes("email")
  );
  const passwordField = parsedForm.inputs.find(
    (input) => input.type === "password"
  );

  loginBody.set(usernameField?.name ?? "username", POLYARES_USERNAME);
  loginBody.set(passwordField?.name ?? "password", POLYARES_PASSWORD);

  return loginBody;
}

function extractCsrfFields(
  hiddenFields: Record<string, string>
): Record<string, string> {
  const csrfNames = [
    "_csrf",
    "csrf_token",
    "csrf",
    "csrfToken",
    "authenticity_token",
    "csrfmiddlewaretoken",
  ];
  const csrfFields: Record<string, string> = {};

  for (const [name, value] of Object.entries(hiddenFields)) {
    const lower = name.toLowerCase();
    if (
      csrfNames.some(
        (tokenName) =>
          lower === tokenName.toLowerCase() || lower.includes("csrf")
      )
    ) {
      csrfFields[name] = value;
    }
  }

  return csrfFields;
}

function polyaresLoginHeaders(): Record<string, string> {
  return {
    "User-Agent": POLYARES_USER_AGENT,
    Accept: POLYARES_HTML_ACCEPT,
    Referer: POLYARES_LOGIN_URL,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function formatAxiosErrorBody(data: unknown): string {
  if (typeof data === "string") {
    return data.slice(0, 2000);
  }
  return JSON.stringify(data, null, 2);
}

function parsePolyaresCommission(value: unknown): number {
  const cleaned = String(value ?? "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  return parseNumber(cleaned);
}

/**
 * Logs into Polyares affiliates portal and downloads income-by-period CSV.
 */
export async function fetchPolyaresPayouts(
  startDate: string,
  endDate: string
): Promise<PublisherPayoutRow[]> {
  const jar = new CookieJar();
  const client = createPolyaresClient(jar);

  logPolyaresStep("step 1 — GET login page", {
    url: POLYARES_LOGIN_URL,
    method: "GET",
    headers: {
      "User-Agent": POLYARES_USER_AGENT,
      Accept: POLYARES_HTML_ACCEPT,
    },
  });

  let loginPageHtml: string;
  try {
    const loginPageResponse = await client.get<string>(POLYARES_LOGIN_URL, {
      responseType: "text",
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
        Accept: POLYARES_HTML_ACCEPT,
      },
      maxRedirects: 5,
    });

    loginPageHtml =
      typeof loginPageResponse.data === "string"
        ? loginPageResponse.data
        : String(loginPageResponse.data ?? "");

    logPolyaresStep("step 1 — GET login page response", {
      status: loginPageResponse.status,
      statusText: loginPageResponse.statusText,
      contentType: loginPageResponse.headers["content-type"] ?? null,
      htmlLength: loginPageHtml.length,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 1 — GET login page failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const parsedForm = parseLoginForm(loginPageHtml);
  const csrfFields = extractCsrfFields(parsedForm.hiddenFields);

  logPolyaresStep("step 2 — parsed login form hidden fields", {
    hiddenFieldNames: Object.keys(parsedForm.hiddenFields),
    csrfFields: Object.keys(csrfFields),
    csrfValuesPresent: Object.fromEntries(
      Object.entries(csrfFields).map(([key, value]) => [
        key,
        value ? "[present]" : "[empty]",
      ])
    ),
  });

  logPolyaresStep("step 2b — login form fields and action", {
    formActionRaw: parsedForm.formActionRaw,
    formActionUrl: parsedForm.actionUrl,
    usesYii2LoginForm: parsedForm.usesYii2LoginForm,
    allInputs: parsedForm.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      value: input.type === "password" ? "[masked]" : input.value,
    })),
  });

  const loginBody = buildPolyaresLoginBody(parsedForm);
  const loginPostUrl = parsedForm.actionUrl;
  const loginBodyString = loginBody.toString();
  const loginHeaders = polyaresLoginHeaders();

  logPolyaresStep("step 3 — POST login request", {
    url: loginPostUrl,
    method: "POST",
    headers: loginHeaders,
    body: loginBodyString,
    usesYii2LoginForm: parsedForm.usesYii2LoginForm,
  });

  try {
    const loginResponse = await client.post(
      loginPostUrl,
      loginBodyString,
      {
        headers: loginHeaders,
        maxRedirects: 5,
        responseType: "text",
        validateStatus: (status) => status >= 200 && status < 400,
      }
    );

    logPolyaresStep("step 3 — POST login response", {
      status: loginResponse.status,
      statusText: loginResponse.statusText,
      finalUrl: loginResponse.request?.res?.responseUrl ?? loginPostUrl,
      contentType: loginResponse.headers["content-type"] ?? null,
      bodyPreview:
        typeof loginResponse.data === "string"
          ? loginResponse.data.slice(0, 500)
          : null,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 3 — POST login failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        headers: error.response?.headers ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const dateStart = isoToChicagoMdY(startDate);
  const dateEnd = isoToChicagoMdY(endDate);
  const exportUrl = `${POLYARES_BASE_URL}/reports/income-by-period/export?date_start=${encodeURIComponent(dateStart)}&date_end=${encodeURIComponent(dateEnd)}`;

  logPolyaresStep("step 4 — GET CSV export", {
    url: exportUrl,
    method: "GET",
    dateStart,
    dateEnd,
  });

  let csvResponse;
  try {
    csvResponse = await client.get<string>(exportUrl, {
      responseType: "text",
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
        Accept: "text/csv,text/plain,*/*",
        Referer: POLYARES_BASE_URL,
      },
    });

    logPolyaresStep("step 4 — GET CSV export response", {
      status: csvResponse.status,
      contentType: csvResponse.headers["content-type"] ?? null,
      bytes:
        typeof csvResponse.data === "string" ? csvResponse.data.length : 0,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 4 — GET CSV export failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const csvText =
    typeof csvResponse.data === "string"
      ? csvResponse.data
      : String(csvResponse.data ?? "");

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const rows: PublisherPayoutRow[] = [];

  for (const record of records) {
    const affiliate = String(record.Affiliate ?? "").trim();
    const commission = parsePolyaresCommission(record.Commission);
    // "Source" is Polyares' stable affiliate ID (e.g. safderygd1) — the
    // durable merge key, immune to the CSV's name-whitespace quirks.
    const polyaresId = String(record.Source ?? "").trim();

    if (!affiliate || commission === 0) {
      continue;
    }

    rows.push({
      publisherName: affiliate,
      payoutAmount: commission,
      source: "POLYERAS",
      ...(polyaresId ? { polyaresId } : {}),
    });
  }

  const aggregated = aggregatePolyaresRows(rows);

  console.log(
    `[PaymentAgent] Polyares CSV parsed: ${aggregated.length} affiliates (${rows.length} raw rows, ${dateStart} – ${dateEnd})`
  );

  return aggregated;
}

/** Allowed payment method tags for affiliate metadata (payment portal). */
export const PAYMENT_METHODS = [
  "PayPal",
  "Wise",
  "Venmo",
  "Bill.com",
  "Crypto",
  "Untagged",
] as const;

/** Allowed payment terms tags for affiliate metadata (payment portal). */
export const PAYMENT_TERMS = [
  "Weekly",
  "Biweekly",
  "Monthly",
  "Untagged",
] as const;

export type PaymentMethodTag = (typeof PAYMENT_METHODS)[number];
export type PaymentTermsTag = (typeof PAYMENT_TERMS)[number];

export interface AffiliateMetadata {
  paymentMethod: string | null;
  paymentTerms: string | null;
  isPaid: boolean;
  paidAt: string | null;
  updatedAt: string | null;
}

export type AffiliateMetadataMap = Record<string, AffiliateMetadata>;

/** Resolve merged total payout for one publisher in a date range. */
export async function resolvePublisherPayoutAmount(
  publisherName: string,
  startDate: string,
  endDate: string
): Promise<number> {
  const [ringbaPublishers, polyaresPublishers] = await Promise.all([
    fetchPublisherPayouts(startDate, endDate),
    fetchPolyaresPayouts(startDate, endDate),
  ]);
  const { publishers } = mergeAffiliates(ringbaPublishers, polyaresPublishers);
  const target = normalizePublisherName(publisherName);
  const row = publishers.find(
    (publisher) => normalizePublisherName(publisher.publisherName) === target
  );
  if (!row) {
    throw new Error(`Publisher not found: ${publisherName}`);
  }
  if (row.totalAmount <= 0) {
    throw new Error(`No payout amount for ${publisherName}`);
  }
  return row.totalAmount;
}

/** Sum merged payout totals for one publisher across multiple date ranges. */
export async function sumPublisherPayoutAcrossMonths(
  publisherName: string,
  ranges: Array<{ startDate: string; endDate: string }>
): Promise<number> {
  let total = 0;

  for (const range of ranges) {
    try {
      total += await resolvePublisherPayoutAmount(
        publisherName,
        range.startDate,
        range.endDate
      );
    } catch (err) {
      if (err instanceof Error) {
        const message = err.message;
        if (
          message.includes("Publisher not found") ||
          message.includes("No payout amount")
        ) {
          continue;
        }
      }
      throw err;
    }
  }

  if (total <= 0) {
    throw new Error(
      `No payout amount for ${publisherName} across selected months`
    );
  }

  return total;
}

export interface PayableRecipientMatch {
  id: number;
  accountHolderName: string;
  currency: string;
  country: string;
  email?: string | null;
}

/** Match a Wise recipient to a publisher by holder name or email. */
export function matchWiseRecipientByName(
  recipients: PayableRecipientMatch[],
  publisherName: string
): PayableRecipientMatch | null {
  const target = normalizePublisherName(publisherName);

  for (const recipient of recipients) {
    if (normalizePublisherName(recipient.accountHolderName) === target) {
      return recipient;
    }
  }

  for (const recipient of recipients) {
    const holder = normalizePublisherName(recipient.accountHolderName);
    if (holder.includes(target) || target.includes(holder)) {
      return recipient;
    }
  }

  if (target.includes("@")) {
    for (const recipient of recipients) {
      const email = recipient.email?.trim().toLowerCase();
      if (email && email === target) {
        return recipient;
      }
    }
  }

  return null;
}

export interface PayableVendorMatch {
  id: string;
  name: string;
  email?: string | null;
}

/** Match a Bill.com vendor to a publisher by name. */
export function matchBillcomVendorByName(
  vendors: PayableVendorMatch[],
  publisherName: string
): PayableVendorMatch | null {
  const target = normalizePublisherName(publisherName);

  for (const vendor of vendors) {
    if (normalizePublisherName(vendor.name) === target) {
      return vendor;
    }
  }

  for (const vendor of vendors) {
    const name = normalizePublisherName(vendor.name);
    if (name.includes(target) || target.includes(name)) {
      return vendor;
    }
  }

  return null;
}

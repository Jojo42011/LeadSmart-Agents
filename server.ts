import "dotenv/config";
import * as path from "path";
import express from "express";
import Database from "better-sqlite3";
import {
  ensureScrubLogSchema,
  getAllAffiliateMetadata,
  upsertAffiliateMetadata,
  toggleAffiliatePaidForMonth,
  markAffiliatePaidForMonths,
  isAffiliatePaidForMonth,
  setAffiliateBillcomVendorId,
  type AffiliateMetadata,
  type BillcomAchFieldUpdates,
  type WiseFieldUpdates,
} from "./lib/logger";
import { getDataDir, getDbPath, getPublicDir } from "./lib/paths";
import { importDatabaseFile } from "./lib/importDatabase";
import { triggerPollNow } from "./lib/pollScheduler";
import {
  fetchPublisherPayouts,
  fetchPolyaresPayouts,
  fetchPublisherProfitData,
  mergeAffiliates,
  parseNumbersCSV,
  rentalCostsFromNumberCounts,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  sumPublisherPayoutAcrossMonths,
  matchWiseRecipientByName,
} from "./agents/paymentAgent";
import {
  getRecipients,
  executeWisePayout,
  prepareWiseTransfer,
  fundTransfer,
  getWiseProfileIdFromEnv,
  resolveWiseIdentifier,
  resolveWisePayoutTarget,
  isWiseAchComplete,
  parseWiseRecipientIdInput,
  formatWiseRecipientIdForStorage,
  type WiseAchDetails,
  type WiseRecipient,
  type WisePayoutTarget,
} from "./lib/wiseClient";
import {
  bulkPayBills,
  prepareBillcomPayout,
  payBill,
  mfaChallenge,
  mfaAuthenticateAndSave,
  isBillcomUntrustedSession,
  getBillcomSessionId,
  isBillcomAchComplete,
  type BillcomAchDetails,
} from "./lib/billcomClient";
import { storePendingBillcomPay, takePendingBillcomPay } from "./lib/billcomPendingPay";
import { warnMissingPaymentEnvVars } from "./lib/paymentEnv";
import { sendPaymentConfirmationEmail } from "./lib/paymentEmail";

import http from "http";
import { handleDeepgramUpgrade } from "./hull/voice/deepgramProxy";
import { generateTTS } from "./hull/voice/tts";
import { sanitizeSpeech } from "./hull/voice/sanitizeSpeech";
import { handleChatCompletions, handleVoiceCommand } from "./hull/brain/agent-loop";
import { runPostConversationExtraction } from "./hull/memory/extraction";
import { buildMemoryPacketForQuery } from "./hull/brain/tools";
import { handleActivation } from "./hull/briefing";
import {
  getMemoryOverview,
  getGraphForEntity,
  getMemoryIdentity,
  listEpisodes,
  listFacts,
  listRules,
  listSyntheses,
} from "./hull/memory/readApi";
import { handleHullEventsUpgrade, broadcastHullEvent } from "./hull/ws";
import { getChatModel, getOpenAIClient } from "./hull/openaiConfig";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DB_PATH = getDbPath();
const PUBLIC_DIR = getPublicDir();

const DEFAULT_POLL_INTERVAL_MS = 28_800_000; // 8 hours

function envPollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_POLL_INTERVAL_MS : parsed;
}

interface ScrubRow {
  id: number;
  taskId: string | null;
  inboundCallId: string;
  publisherName: string | null;
  amountVoided: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

function openDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

function getOverview() {
  const db = openDb();
  try {
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS totalScrubs,
           COALESCE(SUM(
             CASE
               WHEN voidPayoutAmount IS NOT NULL OR voidConversionAmount IS NOT NULL
               THEN COALESCE(voidPayoutAmount, 0)
               ELSE COALESCE(amountVoided, 0)
             END
           ), 0) AS totalPayoutVoided,
           COALESCE(SUM(COALESCE(voidConversionAmount, 0)), 0) AS totalRevenueVoided
         FROM scrub_log
         WHERE status = 'success'`
      )
      .get() as {
      totalScrubs: number;
      totalPayoutVoided: number;
      totalRevenueVoided: number;
    };

    const pollRow = db
      .prepare(
        "SELECT lastSuccessfulPollAt FROM poll_state WHERE id = 1"
      )
      .get() as { lastSuccessfulPollAt: string | null } | undefined;

    const lastRunAt = pollRow?.lastSuccessfulPollAt ?? null;

    let lastRun = {
      timestamp: lastRunAt,
      voided: 0,
      skipped: null as number | null,
      errors: 0,
      dryRuns: 0,
    };

    if (lastRunAt) {
      const window = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS voided,
             SUM(CASE WHEN status IN ('error', 'void_success_approve_failed') THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'dry_run' THEN 1 ELSE 0 END) AS dryRuns
           FROM scrub_log
           WHERE createdAt > datetime(?, '-11 minutes')
             AND createdAt <= datetime(?, '+1 second')`
        )
        .get(lastRunAt, lastRunAt) as {
        voided: number | null;
        errors: number | null;
        dryRuns: number | null;
      };

      lastRun = {
        timestamp: lastRunAt,
        voided: window.voided ?? 0,
        skipped: null,
        errors: window.errors ?? 0,
        dryRuns: window.dryRuns ?? 0,
      };
    }

    const pollIntervalMs = envPollIntervalMs();
    let nextRunAt: string | null = null;
    if (lastRunAt) {
      const nextMs = new Date(lastRunAt).getTime() + pollIntervalMs;
      nextRunAt = new Date(nextMs).toISOString();
    }

    return {
      totalScrubs: totals.totalScrubs,
      totalPayoutVoided: totals.totalPayoutVoided,
      totalRevenueVoided: totals.totalRevenueVoided,
      lastRun,
      pollIntervalMs,
      nextRunAt,
    };
  } finally {
    db.close();
  }
}

function getScrubs(limit: number): ScrubRow[] {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT id, taskId, inboundCallId, publisherName, amountVoided, status, errorMessage, createdAt
         FROM scrub_log
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as ScrubRow[];
  } finally {
    db.close();
  }
}

interface StatsRecentScrub {
  publisherName: string | null;
  voidPayoutAmount: number | null;
  voidConversionAmount: number | null;
  status: string;
  createdAt: string;
}

function getStats() {
  const db = openDb();
  try {
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS totalScrubs,
           COALESCE(SUM(COALESCE(voidPayoutAmount, 0)), 0) AS totalPayoutVoided,
           COALESCE(SUM(COALESCE(voidConversionAmount, 0)), 0) AS totalRevenueVoided
         FROM scrub_log
         WHERE status = 'success'`
      )
      .get() as {
      totalScrubs: number;
      totalPayoutVoided: number;
      totalRevenueVoided: number;
    };

    const lastRunRow = db
      .prepare(
        `SELECT createdAt FROM scrub_log ORDER BY createdAt DESC LIMIT 1`
      )
      .get() as { createdAt: string } | undefined;

    const pollRow = db
      .prepare(
        "SELECT lastSuccessfulPollAt FROM poll_state WHERE id = 1"
      )
      .get() as { lastSuccessfulPollAt: string | null } | undefined;

    const pollIntervalMs = envPollIntervalMs();
    let nextRun = 0;
    const lastPollAt = pollRow?.lastSuccessfulPollAt;
    if (lastPollAt) {
      const nextMs = new Date(lastPollAt).getTime() + pollIntervalMs;
      nextRun = Math.max(0, nextMs - Date.now());
    }

    const recentScrubs = db
      .prepare(
        `SELECT publisherName, voidPayoutAmount, voidConversionAmount, status, createdAt
         FROM scrub_log
         ORDER BY createdAt DESC
         LIMIT 10`
      )
      .all() as StatsRecentScrub[];

    return {
      totalScrubs: totals.totalScrubs,
      totalPayoutVoided: totals.totalPayoutVoided,
      totalRevenueVoided: totals.totalRevenueVoided,
      lastRun: lastRunRow?.createdAt ?? null,
      nextRun,
      recentScrubs,
    };
  } finally {
    db.close();
  }
}

ensureScrubLogSchema();

const app = express();

function setCorsHeaders(res: express.Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.use("/api", (req, res, next) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function isImportAuthorized(req: express.Request): boolean {
  const secret = process.env.DB_IMPORT_SECRET;
  if (!secret) {
    return false;
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return false;
  }
  return auth.slice(7) === secret;
}

app.post(
  "/api/import-db",
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  (req, res) => {
    if (!isImportAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Expected raw SQLite file body" });
      return;
    }

    try {
      const result = importDatabaseFile(body);
      console.log(
        `[Dashboard] Imported database: ${result.scrubRows} rows, ${result.bytes} bytes → ${result.path}`
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  }
);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

console.log(`[Dashboard] Public dir: ${PUBLIC_DIR}`);
console.log(`[Dashboard] Data dir: ${getDataDir()}`);
console.log(`[Dashboard] Database: ${DB_PATH}`);

app.get("/api/overview", (_req, res) => {
  try {
    res.json(getOverview());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read database",
    });
  }
});

app.post("/api/run-now", async (_req, res) => {
  try {
    const outcome = await triggerPollNow();

    if (outcome.status === "already_running") {
      res.status(409).json({
        error: "A scrub run is already in progress",
        status: outcome.status,
      });
      return;
    }

    if (outcome.status === "auth_stopped") {
      res.status(503).json({
        error: "Scrub agent stopped due to auth failure",
        status: outcome.status,
      });
      return;
    }

    res.json({
      status: outcome.status,
      result: outcome.result,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to start scrub run",
    });
  }
});

app.get("/api/scrubs", (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
    res.json(getScrubs(limit));
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read database",
    });
  }
});

app.get("/api/stats", (_req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read database",
    });
  }
});

app.get("/jarvis", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "jarvis.html"));
});

const CHICAGO_TZ = "America/Chicago";

function getChicagoOffsetMs(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const read = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  let hour = read("hour");
  if (hour === 24) {
    hour = 0;
  }
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second")
  );
  return asUtc - at.getTime();
}

function chicagoLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  for (let i = 0; i < 3; i++) {
    const offset = getChicagoOffsetMs(new Date(utcMs));
    utcMs =
      Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset;
  }
  return new Date(utcMs);
}

function chicagoNowYearMonth(): { year: number; monthNum: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const read = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return { year: read("year"), monthNum: read("month") };
}

function monthToDateRange(month?: string): {
  month: string;
  startDate: string;
  endDate: string;
} {
  let year: number;
  let monthNum: number;

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-");
    year = parseInt(y, 10);
    monthNum = parseInt(m, 10);
  } else {
    const now = chicagoNowYearMonth();
    year = now.year;
    monthNum = now.monthNum;
  }

  const monthKey = `${year}-${String(monthNum).padStart(2, "0")}`;
  const start = chicagoLocalToUtc(year, monthNum, 1, 0, 0, 0, 0);
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  const nextYear = monthNum === 12 ? year + 1 : year;
  const end = new Date(
    chicagoLocalToUtc(nextYear, nextMonth, 1, 0, 0, 0, 0).getTime() - 1
  );

  return {
    month: monthKey,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

app.get("/payment", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "payment.html"));
});

app.get("/payments", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "payment.html"));
});

app.get("/api/payment/stats", async (req, res) => {
  try {
    const monthParam =
      typeof req.query.month === "string" ? req.query.month : undefined;
    const range = monthToDateRange(monthParam);
    const publishers = await fetchPublisherPayouts(
      range.startDate,
      range.endDate
    );

    const totalPayout = publishers.reduce(
      (sum, row) => sum + row.payoutAmount,
      0
    );

    res.json({
      month: range.month,
      startDate: range.startDate,
      endDate: range.endDate,
      lastUpdated: new Date().toISOString(),
      totalAffiliates: publishers.length,
      totalPayout,
      publishers,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch payment stats",
    });
  }
});

app.get("/api/payment/stats/all", async (req, res) => {
  try {
    const monthParam =
      typeof req.query.month === "string" ? req.query.month : undefined;
    const range = monthToDateRange(monthParam);

    const [ringbaPublishers, polyaresPublishers] = await Promise.all([
      fetchPublisherPayouts(range.startDate, range.endDate),
      fetchPolyaresPayouts(range.startDate, range.endDate),
    ]);

    const { publishers, outliers } = mergeAffiliates(
      ringbaPublishers,
      polyaresPublishers
    );

    const publishersWithCpl = publishers.map((publisher) => ({
      ...publisher,
      cplAffiliate: publisher.cplAffiliate === true,
    }));

    const ringbaTotalPayout = ringbaPublishers.reduce(
      (sum, row) => sum + row.payoutAmount,
      0
    );
    const polyareasTotalPayout = polyaresPublishers.reduce(
      (sum, row) => sum + row.payoutAmount,
      0
    );
    const grandTotalPayout = ringbaTotalPayout + polyareasTotalPayout;

    res.json({
      month: range.month,
      startDate: range.startDate,
      endDate: range.endDate,
      lastUpdated: new Date().toISOString(),
      totalAffiliates: publishers.length,
      ringbaTotalPayout,
      polyareasTotalPayout,
      grandTotalPayout,
      publishers: publishersWithCpl,
      outliers,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch payment stats",
    });
  }
});

app.get("/api/payment/profit", async (req, res) => {
  try {
    const monthParam =
      typeof req.query.month === "string" ? req.query.month : undefined;
    const range = monthToDateRange(monthParam);
    const publishers = await fetchPublisherProfitData(
      range.startDate,
      range.endDate
    );

    res.json({
      month: range.month,
      startDate: range.startDate,
      endDate: range.endDate,
      lastUpdated: new Date().toISOString(),
      totalPublishers: publishers.length,
      publishers,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch profit data",
    });
  }
});

app.post(
  "/api/payment/numbers-csv",
  express.text({ type: "*/*", limit: "10mb" }),
  (req, res) => {
    try {
      const csvText = typeof req.body === "string" ? req.body : "";
      if (!csvText.trim()) {
        res.status(400).json({ error: "CSV body is required" });
        return;
      }

      const counts = parseNumbersCSV(csvText);
      const rentalCosts = rentalCostsFromNumberCounts(counts);
      res.json({ rentalCosts });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to parse CSV",
      });
    }
  }
);

function decodePublisherParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeMetadataTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "Untagged") {
    return null;
  }
  return trimmed;
}

function normalizeBillcomVendorId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Bill.com vendor ID must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^009[0-9A-Za-z]+$/.test(trimmed)) {
    throw new Error("Bill.com vendor ID must start with 009");
  }
  if (trimmed.length > 64) {
    throw new Error("Bill.com vendor ID is too long");
  }
  return trimmed;
}

function readOptionalString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isMaskedAccountNumber(value: string): boolean {
  return /^\*+\d{0,4}$/.test(value.trim());
}

function normalizeRoutingNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) {
    throw new Error("Routing number must be 9 digits");
  }
  return digits;
}

function normalizeState(value: string): string {
  const state = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new Error("State must be a 2-letter US code (e.g. TX)");
  }
  return state;
}

function normalizeZip(value: string): string {
  const zip = value.trim();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new Error("ZIP must be 5 digits or ZIP+4 (12345 or 12345-6789)");
  }
  return zip;
}

function achDetailsFromMetadata(meta: AffiliateMetadata | null): Partial<BillcomAchDetails> {
  if (!meta) {
    return {};
  }
  return {
    payeeName: meta.billcomPayeeName ?? undefined,
    accountHolderName: meta.billcomAccountHolderName ?? undefined,
    routingNumber: meta.billcomRoutingNumber ?? undefined,
    accountNumber: meta.billcomAccountNumber ?? undefined,
    addressLine1: meta.billcomAddressLine1 ?? undefined,
    city: meta.billcomAddressCity ?? undefined,
    state: meta.billcomAddressState ?? undefined,
    zip: meta.billcomAddressZip ?? undefined,
  };
}

function parseBillcomAchUpdates(
  body: unknown,
  existing: AffiliateMetadata | null
): BillcomAchFieldUpdates | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const updates: BillcomAchFieldUpdates = {};
  let hasUpdate = false;

  const payeeName = readOptionalString(body, "billcomPayeeName");
  if (payeeName !== undefined) {
    updates.billcomPayeeName = payeeName;
    hasUpdate = true;
  }

  const accountHolder = readOptionalString(body, "billcomAccountHolderName");
  if (accountHolder !== undefined) {
    updates.billcomAccountHolderName = accountHolder;
    hasUpdate = true;
  }

  const routingRaw = readOptionalString(body, "billcomRoutingNumber");
  if (routingRaw !== undefined) {
    updates.billcomRoutingNumber = routingRaw ? normalizeRoutingNumber(routingRaw) : null;
    hasUpdate = true;
  }

  const accountRaw = readOptionalString(body, "billcomAccountNumber");
  if (accountRaw !== undefined) {
    if (!accountRaw || isMaskedAccountNumber(accountRaw)) {
      updates.billcomAccountNumber = existing?.billcomAccountNumber ?? null;
    } else if (accountRaw.replace(/\D/g, "").length < 4) {
      throw new Error("Account number must be at least 4 digits");
    } else {
      updates.billcomAccountNumber = accountRaw.replace(/\s/g, "");
    }
    hasUpdate = true;
  }

  const line1 = readOptionalString(body, "billcomAddressLine1");
  if (line1 !== undefined) {
    updates.billcomAddressLine1 = line1;
    hasUpdate = true;
  }

  const city = readOptionalString(body, "billcomAddressCity");
  if (city !== undefined) {
    updates.billcomAddressCity = city;
    hasUpdate = true;
  }

  const stateRaw = readOptionalString(body, "billcomAddressState");
  if (stateRaw !== undefined) {
    updates.billcomAddressState = stateRaw ? normalizeState(stateRaw) : null;
    hasUpdate = true;
  }

  const zipRaw = readOptionalString(body, "billcomAddressZip");
  if (zipRaw !== undefined) {
    updates.billcomAddressZip = zipRaw ? normalizeZip(zipRaw) : null;
    hasUpdate = true;
  }

  return hasUpdate ? updates : null;
}

function normalizeWiseEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email) {
    return "";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Wise email must be a valid email address");
  }
  return email;
}

function normalizeWiseTag(value: string): string {
  const tag = value.trim().replace(/^@+/, "");
  if (!tag) {
    return "";
  }
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(tag)) {
    throw new Error("Wise tag must be 3–30 characters (letters, numbers, . _ -)");
  }
  return tag;
}

function wiseAchDetailsFromMetadata(
  meta: AffiliateMetadata | null
): Partial<WiseAchDetails> {
  if (!meta) {
    return {};
  }
  return {
    accountHolderName: meta.wiseAccountHolderName ?? undefined,
    routingNumber: meta.wiseRoutingNumber ?? undefined,
    accountNumber: meta.wiseAccountNumber ?? undefined,
    addressLine1: meta.wiseAddressLine1 ?? undefined,
    city: meta.wiseAddressCity ?? undefined,
    state: meta.wiseAddressState ?? undefined,
    zip: meta.wiseAddressZip ?? undefined,
  };
}

function parseWiseFieldUpdates(
  body: unknown,
  existing: AffiliateMetadata | null
): WiseFieldUpdates | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const updates: WiseFieldUpdates = {};
  let hasUpdate = false;

  const emailRaw = readOptionalString(body, "wiseEmail");
  if (emailRaw !== undefined) {
    updates.wiseEmail = emailRaw ? normalizeWiseEmail(emailRaw) : null;
    hasUpdate = true;
  }

  const tagRaw = readOptionalString(body, "wiseTag");
  if (tagRaw !== undefined) {
    updates.wiseTag = tagRaw ? normalizeWiseTag(tagRaw) : null;
    hasUpdate = true;
  }

  const recipientRaw = readOptionalString(body, "wiseRecipientId");
  if (recipientRaw !== undefined) {
    if (!recipientRaw.trim()) {
      updates.wiseRecipientId = null;
    } else {
      const parsed = parseWiseRecipientIdInput(recipientRaw);
      if (parsed === null) {
        throw new Error("Wise recipient ID must be a positive number");
      }
      updates.wiseRecipientId = formatWiseRecipientIdForStorage(parsed);
    }
    hasUpdate = true;
  }

  const accountHolder = readOptionalString(body, "wiseAccountHolderName");
  if (accountHolder !== undefined) {
    updates.wiseAccountHolderName = accountHolder;
    hasUpdate = true;
  }

  const routingRaw = readOptionalString(body, "wiseRoutingNumber");
  if (routingRaw !== undefined) {
    updates.wiseRoutingNumber = routingRaw ? normalizeRoutingNumber(routingRaw) : null;
    hasUpdate = true;
  }

  const accountRaw = readOptionalString(body, "wiseAccountNumber");
  if (accountRaw !== undefined) {
    if (!accountRaw || isMaskedAccountNumber(accountRaw)) {
      updates.wiseAccountNumber = existing?.wiseAccountNumber ?? null;
    } else if (accountRaw.replace(/\D/g, "").length < 4) {
      throw new Error("Wise account number must be at least 4 digits");
    } else {
      updates.wiseAccountNumber = accountRaw.replace(/\s/g, "");
    }
    hasUpdate = true;
  }

  const line1 = readOptionalString(body, "wiseAddressLine1");
  if (line1 !== undefined) {
    updates.wiseAddressLine1 = line1;
    hasUpdate = true;
  }

  const city = readOptionalString(body, "wiseAddressCity");
  if (city !== undefined) {
    updates.wiseAddressCity = city;
    hasUpdate = true;
  }

  const stateRaw = readOptionalString(body, "wiseAddressState");
  if (stateRaw !== undefined) {
    updates.wiseAddressState = stateRaw ? normalizeState(stateRaw) : null;
    hasUpdate = true;
  }

  const zipRaw = readOptionalString(body, "wiseAddressZip");
  if (zipRaw !== undefined) {
    updates.wiseAddressZip = zipRaw ? normalizeZip(zipRaw) : null;
    hasUpdate = true;
  }

  return hasUpdate ? updates : null;
}

function mergedWiseAchDetails(
  meta: AffiliateMetadata | null,
  updates: WiseFieldUpdates | null
): Partial<WiseAchDetails> {
  const merged: Partial<WiseAchDetails> = {
    ...wiseAchDetailsFromMetadata(meta),
  };
  if (!updates) {
    return merged;
  }
  if (updates.wiseAccountHolderName !== undefined) {
    merged.accountHolderName = updates.wiseAccountHolderName ?? undefined;
  }
  if (updates.wiseRoutingNumber !== undefined) {
    merged.routingNumber = updates.wiseRoutingNumber ?? undefined;
  }
  if (updates.wiseAccountNumber !== undefined) {
    merged.accountNumber = updates.wiseAccountNumber ?? undefined;
  }
  if (updates.wiseAddressLine1 !== undefined) {
    merged.addressLine1 = updates.wiseAddressLine1 ?? undefined;
  }
  if (updates.wiseAddressCity !== undefined) {
    merged.city = updates.wiseAddressCity ?? undefined;
  }
  if (updates.wiseAddressState !== undefined) {
    merged.state = updates.wiseAddressState ?? undefined;
  }
  if (updates.wiseAddressZip !== undefined) {
    merged.zip = updates.wiseAddressZip ?? undefined;
  }
  return merged;
}

function hasWisePayoutDetails(
  wiseEmail: string | null | undefined,
  wiseTag: string | null | undefined,
  ach: Partial<WiseAchDetails> | null | undefined,
  wiseRecipientId: string | null | undefined
): boolean {
  const storedId = wiseRecipientId?.trim() ?? "";
  if (storedId && parseWiseRecipientIdInput(storedId) !== null) {
    return true;
  }
  return Boolean(resolveWiseIdentifier(wiseEmail, wiseTag) || isWiseAchComplete(ach));
}

function resolveWiseRecipientIdForPay(
  meta: AffiliateMetadata | null,
  body: unknown
): number | null {
  const raw = readOptionalString(body, "wiseRecipientId");
  if (raw !== undefined) {
    if (!raw.trim()) {
      return null;
    }
    return parseWiseRecipientIdInput(raw);
  }

  const stored = meta?.wiseRecipientId?.trim() ?? "";
  if (!stored) {
    return null;
  }
  return parseWiseRecipientIdInput(stored);
}

function persistWiseRecipientIdFromPayout(
  publisherName: string,
  meta: AffiliateMetadata,
  target: WisePayoutTarget | { contactId: string; resolvedVia: "contact" }
): void {
  if (!("recipientId" in target)) {
    return;
  }
  if (target.resolvedVia !== "ach" && target.resolvedVia !== "recipient") {
    return;
  }
  const stored = formatWiseRecipientIdForStorage(target.recipientId);
  if (meta.wiseRecipientId === stored) {
    return;
  }
  upsertAffiliateMetadata(
    publisherName,
    meta.paymentMethod,
    meta.paymentTerms,
    meta.billcomVendorId,
    null,
    { wiseRecipientId: stored }
  );
}

function normalizePaymentEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email) {
    return "";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Payment confirmation email must be a valid email address");
  }
  return email;
}

function parsePaymentEmailUpdate(body: unknown): string | null | undefined {
  if (!body || typeof body !== "object" || !("paymentEmail" in body)) {
    return undefined;
  }
  const value = (body as { paymentEmail?: unknown }).paymentEmail;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Payment confirmation email must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return normalizePaymentEmail(trimmed);
}

function trySendPaymentConfirmation(
  publisherName: string,
  amount: number,
  months: string[],
  method: "Wise" | "Bill.com"
): void {
  void (async () => {
    const meta = affiliateMetadataFor(publisherName);
    const email = meta?.paymentEmail?.trim();
    if (!email) {
      console.log(`[Payment] No confirmation email for ${publisherName}, skipping`);
      return;
    }

    try {
      await sendPaymentConfirmationEmail({
        publisherName,
        email,
        amount,
        months,
        method,
      });
      console.log(
        `[Payment] Confirmation email sent to ${email} for ${publisherName}`
      );
    } catch (err) {
      console.error(
        `[Payment] Confirmation email failed for ${publisherName}:`,
        err instanceof Error ? err.message : err
      );
    }
  })();
}

function wiseDetailsFromMetadata(meta: AffiliateMetadata | null): {
  wiseEmail: string | null;
  wiseTag: string | null;
} {
  return {
    wiseEmail: meta?.wiseEmail ?? null,
    wiseTag: meta?.wiseTag ?? null,
  };
}

function resolveWiseFieldsForPay(
  meta: AffiliateMetadata | null,
  body: unknown
): { wiseEmail: string | null; wiseTag: string | null } {
  const merged = wiseDetailsFromMetadata(meta);

  const emailRaw = readOptionalString(body, "wiseEmail");
  if (emailRaw !== undefined) {
    merged.wiseEmail = emailRaw ? normalizeWiseEmail(emailRaw) : null;
  }

  const tagRaw = readOptionalString(body, "wiseTag");
  if (tagRaw !== undefined) {
    merged.wiseTag = tagRaw ? normalizeWiseTag(tagRaw) : null;
  }

  return merged;
}

async function resolveWisePayoutForAffiliate(
  profileId: string,
  recipients: WiseRecipient[],
  meta: AffiliateMetadata | null,
  publisherName: string,
  body: unknown
) {
  const { wiseEmail, wiseTag } = resolveWiseFieldsForPay(meta, body);
  const achDetails = resolveWiseAchForPay(meta, body);
  const storedRecipientId = resolveWiseRecipientIdForPay(meta, body);

  if (
    hasWisePayoutDetails(
      wiseEmail,
      wiseTag,
      achDetails,
      storedRecipientId !== null
        ? formatWiseRecipientIdForStorage(storedRecipientId)
        : meta?.wiseRecipientId
    )
  ) {
    return resolveWisePayoutTarget(
      profileId,
      recipients,
      wiseEmail,
      wiseTag,
      achDetails,
      storedRecipientId
    );
  }

  const byName = matchWiseRecipientByName(recipients, publisherName);
  if (byName) {
    return { recipientId: byName.id, resolvedVia: "recipient" as const };
  }

  throw new Error(
    "Add Wise recipient ID, email/tag (Wise-to-Wise), or full ACH + US address in affiliate settings"
  );
}

function resolveWiseAchForPay(
  meta: AffiliateMetadata | null,
  body: unknown
): WiseAchDetails | null {
  const merged: Partial<WiseAchDetails> = {
    ...wiseAchDetailsFromMetadata(meta),
  };

  const accountHolder = readOptionalString(body, "wiseAccountHolderName");
  if (accountHolder) {
    merged.accountHolderName = accountHolder;
  }
  const routing = readOptionalString(body, "wiseRoutingNumber");
  if (routing) {
    merged.routingNumber = normalizeRoutingNumber(routing);
  }
  const account = readOptionalString(body, "wiseAccountNumber");
  if (account && !isMaskedAccountNumber(account)) {
    merged.accountNumber = account.replace(/\s/g, "");
  }
  const line1 = readOptionalString(body, "wiseAddressLine1");
  if (line1) {
    merged.addressLine1 = line1;
  }
  const city = readOptionalString(body, "wiseAddressCity");
  if (city) {
    merged.city = city;
  }
  const state = readOptionalString(body, "wiseAddressState");
  if (state) {
    merged.state = normalizeState(state);
  }
  const zip = readOptionalString(body, "wiseAddressZip");
  if (zip) {
    merged.zip = normalizeZip(zip);
  }

  return isWiseAchComplete(merged) ? merged : null;
}

function resolveBillcomAchForPay(
  meta: AffiliateMetadata | null,
  body: unknown
): BillcomAchDetails | null {
  const merged: Partial<BillcomAchDetails> = {
    ...achDetailsFromMetadata(meta),
  };

  const payeeName = readOptionalString(body, "billcomPayeeName");
  if (payeeName) {
    merged.payeeName = payeeName;
  }
  const accountHolder = readOptionalString(body, "billcomAccountHolderName");
  if (accountHolder) {
    merged.accountHolderName = accountHolder;
  }
  const routing = readOptionalString(body, "billcomRoutingNumber");
  if (routing) {
    merged.routingNumber = normalizeRoutingNumber(routing);
  }
  const account = readOptionalString(body, "billcomAccountNumber");
  if (account && !isMaskedAccountNumber(account)) {
    merged.accountNumber = account.replace(/\s/g, "");
  }
  const line1 = readOptionalString(body, "billcomAddressLine1");
  if (line1) {
    merged.addressLine1 = line1;
  }
  const city = readOptionalString(body, "billcomAddressCity");
  if (city) {
    merged.city = city;
  }
  const state = readOptionalString(body, "billcomAddressState");
  if (state) {
    merged.state = normalizeState(state);
  }
  const zip = readOptionalString(body, "billcomAddressZip");
  if (zip) {
    merged.zip = normalizeZip(zip);
  }

  return isBillcomAchComplete(merged) ? merged : null;
}

app.get("/api/payment/metadata", (_req, res) => {
  try {
    res.json(getAllAffiliateMetadata());
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error ? err.message : "Failed to fetch affiliate metadata",
    });
  }
});

app.post("/api/payment/metadata/:name", (req, res) => {
  try {
    const publisherName = decodePublisherParam(req.params.name).trim();
    if (!publisherName) {
      res.status(400).json({ error: "Publisher name is required" });
      return;
    }

    const paymentMethod = normalizeMetadataTag(req.body?.paymentMethod);
    const paymentTerms = normalizeMetadataTag(req.body?.paymentTerms);
    const existingMeta = affiliateMetadataFor(publisherName);
    let billcomVendorId: string | null = existingMeta?.billcomVendorId ?? null;
    if (req.body && typeof req.body === "object" && "billcomVendorId" in req.body) {
      billcomVendorId = normalizeBillcomVendorId(
        (req.body as { billcomVendorId?: unknown }).billcomVendorId
      );
    }

    let billcomAch: BillcomAchFieldUpdates | null = null;
    try {
      billcomAch = parseBillcomAchUpdates(req.body, existingMeta);
    } catch (achErr) {
      res.status(400).json({
        error: achErr instanceof Error ? achErr.message : "Invalid ACH details",
      });
      return;
    }

    let wiseFields: WiseFieldUpdates | null = null;
    try {
      wiseFields = parseWiseFieldUpdates(req.body, existingMeta);
    } catch (wiseErr) {
      res.status(400).json({
        error: wiseErr instanceof Error ? wiseErr.message : "Invalid Wise details",
      });
      return;
    }

    if (paymentMethod === "Wise") {
      const nextEmail =
        wiseFields?.wiseEmail !== undefined
          ? wiseFields.wiseEmail
          : existingMeta?.wiseEmail ?? null;
      const nextTag =
        wiseFields?.wiseTag !== undefined
          ? wiseFields.wiseTag
          : existingMeta?.wiseTag ?? null;
      const nextAch = mergedWiseAchDetails(existingMeta, wiseFields);
      const nextRecipientId =
        wiseFields?.wiseRecipientId !== undefined
          ? wiseFields.wiseRecipientId
          : existingMeta?.wiseRecipientId ?? null;
      if (!hasWisePayoutDetails(nextEmail, nextTag, nextAch, nextRecipientId)) {
        res.status(400).json({
          error:
            "Wise requires recipient ID, email/tag (Wise-to-Wise), or full ACH + US address (other platforms)",
        });
        return;
      }
    }

    if (
      paymentMethod !== null &&
      !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)
    ) {
      res.status(400).json({ error: "Invalid payment method" });
      return;
    }

    if (
      paymentTerms !== null &&
      !(PAYMENT_TERMS as readonly string[]).includes(paymentTerms)
    ) {
      res.status(400).json({ error: "Invalid payment terms" });
      return;
    }

    let paymentEmail: string | null | undefined;
    try {
      paymentEmail = parsePaymentEmailUpdate(req.body);
    } catch (emailErr) {
      res.status(400).json({
        error:
          emailErr instanceof Error
            ? emailErr.message
            : "Invalid payment confirmation email",
      });
      return;
    }

    const metadata = upsertAffiliateMetadata(
      publisherName,
      paymentMethod,
      paymentTerms,
      billcomVendorId,
      billcomAch,
      wiseFields,
      paymentEmail
    );
    res.json(metadata);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to save affiliate metadata";
    const status = message.includes("vendor ID") ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/api/payment/mark-paid/:name", (req, res) => {
  try {
    const publisherName = decodePublisherParam(req.params.name).trim();
    if (!publisherName) {
      res.status(400).json({ error: "Publisher name is required" });
      return;
    }

    const monthRaw =
      typeof req.body?.month === "string" && req.body.month.trim()
        ? req.body.month.trim()
        : typeof req.query.month === "string" && req.query.month.trim()
          ? req.query.month.trim()
          : monthToDateRange().month;

    if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
      res.status(400).json({ error: "Invalid month (expected YYYY-MM)" });
      return;
    }

    const result = toggleAffiliatePaidForMonth(publisherName, monthRaw);
    const meta = affiliateMetadataFor(publisherName);
    res.json({
      ...(meta ?? {
        paymentMethod: null,
        paymentTerms: null,
        billcomVendorId: null,
        billcomPayeeName: null,
        billcomAccountHolderName: null,
        billcomRoutingNumber: null,
        billcomAccountNumber: null,
        billcomAddressLine1: null,
        billcomAddressCity: null,
        billcomAddressState: null,
        billcomAddressZip: null,
        isPaid: false,
        paidAt: null,
        updatedAt: null,
      }),
      paidMonths: result.paidMonths,
      isPaid: result.paid,
      paidAt: result.paidAt,
    });
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error ? err.message : "Failed to toggle paid status",
    });
  }
});

function monthFromPayRequest(req: express.Request): string | undefined {
  if (typeof req.body?.month === "string" && req.body.month.trim()) {
    return req.body.month.trim();
  }
  if (typeof req.query.month === "string" && req.query.month.trim()) {
    return req.query.month.trim();
  }
  return undefined;
}

function affiliateMetadataFor(name: string) {
  return getAllAffiliateMetadata()[name] ?? null;
}

function markAffiliatePaidIfUnpaid(
  publisherName: string,
  months: string[]
): void {
  markAffiliatePaidForMonths(publisherName, months);
}

function isAffiliatePaidForAllMonths(
  publisherName: string,
  months: string[]
): boolean {
  if (months.length === 0) {
    return false;
  }
  return months.every((month) => isAffiliatePaidForMonth(publisherName, month));
}

function parsePublisherNames(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const names = (body as { publisherNames?: unknown }).publisherNames;
  if (!Array.isArray(names)) {
    return [];
  }
  return names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
}

function parsePayMonths(req: express.Request): string[] {
  const body = req.body;
  if (body && typeof body === "object" && Array.isArray((body as { months?: unknown }).months)) {
    const months = (body as { months: unknown[] }).months
      .filter((month): month is string => typeof month === "string")
      .map((month) => month.trim())
      .filter((month) => /^\d{4}-\d{2}$/.test(month));
    if (months.length > 0) {
      return months;
    }
  }

  const single = monthFromPayRequest(req);
  return [single ?? monthToDateRange().month];
}

function parsePayAmountOverride(req: express.Request): number | undefined {
  const raw = (req.body as { amount?: unknown } | undefined)?.amount;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 100) / 100;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = parseFloat(raw.replace(/[$,\s]/g, ""));
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.round(parsed * 100) / 100;
    }
  }
  return undefined;
}

async function resolvePayAmount(
  publisherName: string,
  req: express.Request
): Promise<{ amount: number; months: string[] }> {
  const months = parsePayMonths(req);
  const override = parsePayAmountOverride(req);
  if (override !== undefined) {
    return { amount: override, months };
  }

  const ranges = months.map((month) => monthToDateRange(month));
  const amount = await sumPublisherPayoutAcrossMonths(publisherName, ranges);
  return { amount, months };
}

app.post("/api/payment/pay/wise/:name", async (req, res) => {
  try {
    const publisherName = decodePublisherParam(req.params.name).trim();
    if (!publisherName) {
      res.status(400).json({ error: "Publisher name is required" });
      return;
    }

    const months = parsePayMonths(req);
    const override = parsePayAmountOverride(req);
    console.log(
      `[Payment] Wise pay request: ${publisherName} months=${months.join(",")} amount=${override ?? "auto"}`
    );

    const meta = affiliateMetadataFor(publisherName);
    if (!meta || meta.paymentMethod !== "Wise") {
      res.status(400).json({ error: "Affiliate is not tagged for Wise payments" });
      return;
    }
    if (isAffiliatePaidForAllMonths(publisherName, months)) {
      res.status(400).json({
        error: "Affiliate is already marked paid for the selected month(s)",
      });
      return;
    }

    const { amount } = await resolvePayAmount(publisherName, req);

    const profileId = getWiseProfileIdFromEnv();
    const recipients = await getRecipients(profileId);
    const target = await resolveWisePayoutForAffiliate(
      profileId,
      recipients,
      meta,
      publisherName,
      req.body
    );

    const wiseFields = parseWiseFieldUpdates(req.body, meta);
    if (wiseFields) {
      upsertAffiliateMetadata(
        publisherName,
        meta.paymentMethod,
        meta.paymentTerms,
        meta.billcomVendorId,
        null,
        wiseFields
      );
    }

    const payout = await executeWisePayout(
      profileId,
      amount,
      "LeadSmart Affiliate Payout",
      target
    );
    persistWiseRecipientIdFromPayout(publisherName, meta, target);
    markAffiliatePaidIfUnpaid(publisherName, months);
    trySendPaymentConfirmation(publisherName, amount, months, "Wise");

    console.log(
      `[Payment] Wise pay success: ${publisherName} transferId=${payout.transferId} amount=${amount}`
    );

    res.json({
      success: true,
      transferId: payout.transferId,
      amount,
      publisherName,
    });
  } catch (err) {
    console.error(
      `[Payment] Wise pay failed: ${req.params.name}`,
      err instanceof Error ? err.message : err
    );
    res.status(500).json({
      error: err instanceof Error ? err.message : "Wise payout failed",
    });
  }
});

app.post("/api/payment/pay/billcom/:name", async (req, res) => {
  try {
    const publisherName = decodePublisherParam(req.params.name).trim();
    if (!publisherName) {
      res.status(400).json({ error: "Publisher name is required" });
      return;
    }

    const months = parsePayMonths(req);
    const override = parsePayAmountOverride(req);
    console.log(
      `[Payment] Bill.com pay request: ${publisherName} months=${months.join(",")} amount=${override ?? "auto"}`
    );

    const meta = affiliateMetadataFor(publisherName);
    if (!meta || meta.paymentMethod !== "Bill.com") {
      res.status(400).json({
        error: "Affiliate is not tagged for Bill.com payments",
      });
      return;
    }
    if (isAffiliatePaidForAllMonths(publisherName, months)) {
      res.status(400).json({
        error: "Affiliate is already marked paid for the selected month(s)",
      });
      return;
    }

    const { amount } = await resolvePayAmount(publisherName, req);

    let billcomVendorId = meta.billcomVendorId?.trim() ?? "";
    if (typeof req.body?.billcomVendorId === "string" && req.body.billcomVendorId.trim()) {
      billcomVendorId = normalizeBillcomVendorId(req.body.billcomVendorId) ?? "";
      if (billcomVendorId !== (meta.billcomVendorId?.trim() ?? "")) {
        setAffiliateBillcomVendorId(publisherName, billcomVendorId);
        console.log(
          `[Payment] Saved Bill.com vendor ID for ${publisherName}: ${billcomVendorId}`
        );
      }
    }

    const achDetails = resolveBillcomAchForPay(meta, req.body);
    if (!billcomVendorId && !achDetails) {
      res.status(400).json({
        error:
          `No Bill.com vendor ID or ACH details for "${publisherName}". ` +
          "Open the edit popup and add a vendor ID (009...) or fill in ACH + address.",
      });
      return;
    }

    const prepared = await prepareBillcomPayout(publisherName, amount, {
      billcomVendorId: billcomVendorId || null,
      achDetails,
    });

    if (prepared.vendorCreated) {
      setAffiliateBillcomVendorId(publisherName, prepared.vendorId);
      console.log(
        `[Payment] Saved new Bill.com vendor ID for ${publisherName}: ${prepared.vendorId}`
      );
    }

    let achUpdates: BillcomAchFieldUpdates | null = null;
    try {
      achUpdates = parseBillcomAchUpdates(req.body, meta);
    } catch {
      achUpdates = null;
    }
    if (achUpdates) {
      upsertAffiliateMetadata(
        publisherName,
        meta.paymentMethod,
        meta.paymentTerms,
        prepared.vendorId,
        achUpdates
      );
    }

    try {
      const payment = await payBill(prepared.billId, prepared.vendorId, amount, {
        newBankAccount: prepared.vendorCreated,
      });
      markAffiliatePaidIfUnpaid(publisherName, months);
      trySendPaymentConfirmation(publisherName, amount, months, "Bill.com");

      console.log(
        `[Payment] Bill.com pay success: ${publisherName} paymentId=${payment.id} amount=${amount}`
      );

      res.json({
        success: true,
        paymentId: payment.id,
        billId: prepared.billId,
        amount,
        publisherName,
      });
      return;
    } catch (payErr) {
      if (!isBillcomUntrustedSession(payErr)) {
        throw payErr;
      }

      console.log(
        `[Payment] Bill.com untrusted session for ${publisherName} — initiating MFA challenge`
      );
      const sessionId = await getBillcomSessionId();
      const { challengeId } = await mfaChallenge(sessionId);
      const mfaToken = storePendingBillcomPay({
        challengeId,
        sessionId,
        billId: prepared.billId,
        vendorId: prepared.vendorId,
        amount,
        publisherName,
        newBankAccount: prepared.vendorCreated,
        months,
      });

      console.log(
        `[Payment] Bill.com MFA challenge sent for ${publisherName} (mfaToken=${mfaToken}, billId=${prepared.billId})`
      );

      res.status(403).json({
        requiresMfa: true,
        mfaToken,
        billId: prepared.billId,
        message:
          "Bill.com MFA code required. Check the Bill.com app on Seth's phone and enter the code below.",
      });
    }
  } catch (err) {
    console.error(
      `[Payment] Bill.com pay failed: ${req.params.name}`,
      err instanceof Error ? err.message : err
    );
    res.status(500).json({
      error: err instanceof Error ? err.message : "Bill.com payout failed",
    });
  }
});

app.post("/api/payment/billcom/mfa/verify", async (req, res) => {
  try {
    const mfaToken =
      typeof req.body?.mfaToken === "string" ? req.body.mfaToken.trim() : "";
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";

    if (!mfaToken) {
      res.status(400).json({ error: "mfaToken is required" });
      return;
    }
    if (!token) {
      res.status(400).json({ error: "MFA code is required" });
      return;
    }

    const pending = takePendingBillcomPay(mfaToken);
    if (!pending) {
      console.warn("[Payment] Bill.com MFA verify: invalid or expired mfaToken");
      res.status(400).json({
        error: "MFA session expired. Close the modal and try paying again.",
      });
      return;
    }

    console.log(
      `[Payment] Bill.com MFA verify request: publisher=${pending.publisherName} billId=${pending.billId} challengeId=${pending.challengeId}`
    );

    await mfaAuthenticateAndSave(pending.challengeId, token, pending.sessionId);

    console.log(
      `[Payment] Bill.com MFA verified for ${pending.publisherName} — completing pay`
    );

    const payment = await payBill(
      pending.billId,
      pending.vendorId,
      pending.amount,
      {
        newBankAccount: pending.newBankAccount,
      }
    );
    markAffiliatePaidIfUnpaid(pending.publisherName, pending.months);
    trySendPaymentConfirmation(
      pending.publisherName,
      pending.amount,
      pending.months,
      "Bill.com"
    );

    console.log(
      `[Payment] Bill.com pay success after MFA: ${pending.publisherName} paymentId=${payment.id} amount=${pending.amount}`
    );

    res.json({
      success: true,
      paymentId: payment.id,
      billId: pending.billId,
      amount: pending.amount,
      publisherName: pending.publisherName,
    });
  } catch (err) {
    console.error(
      "[Payment] Bill.com MFA verify failed:",
      err instanceof Error ? err.message : err
    );
    res.status(500).json({
      error: err instanceof Error ? err.message : "Bill.com MFA verification failed",
    });
  }
});

app.post("/api/payment/pay/bulk/wise", async (req, res) => {
  const publisherNames = parsePublisherNames(req.body);
  if (publisherNames.length === 0) {
    res.status(400).json({ error: "publisherNames array is required" });
    return;
  }

  const months = parsePayMonths(req);
  console.log(
    `[Payment] Wise bulk pay request: ${publisherNames.length} affiliate(s) months=${months.join(",")}`
  );

  const succeeded: string[] = [];
  const failed: Array<{ publisherName: string; error: string }> = [];
  const profileId = getWiseProfileIdFromEnv();
  const recipients = await getRecipients(profileId);
  const pendingFunds: Array<{
    publisherName: string;
    transferId: number;
    amount: number;
    meta: AffiliateMetadata;
    target: WisePayoutTarget | { contactId: string; resolvedVia: "contact" };
  }> = [];

  for (const publisherName of publisherNames) {
    try {
      const meta = affiliateMetadataFor(publisherName);
      if (!meta || meta.paymentMethod !== "Wise") {
        throw new Error("Affiliate is not tagged for Wise payments");
      }
      if (isAffiliatePaidForAllMonths(publisherName, months)) {
        throw new Error("Affiliate is already marked paid for the selected month(s)");
      }

      const { amount } = await resolvePayAmount(publisherName, req);
      const target = await resolveWisePayoutForAffiliate(
        profileId,
        recipients,
        meta,
        publisherName,
        req.body
      );
      const transfer = await prepareWiseTransfer(
        profileId,
        amount,
        "LeadSmart Affiliate Payout",
        target
      );
      pendingFunds.push({
        publisherName,
        transferId: transfer.transferId,
        amount,
        meta,
        target,
      });
    } catch (err) {
      failed.push({
        publisherName,
        error: err instanceof Error ? err.message : "Wise payout failed",
      });
    }
  }

  for (const pending of pendingFunds) {
    try {
      await fundTransfer(profileId, pending.transferId);
      persistWiseRecipientIdFromPayout(
        pending.publisherName,
        pending.meta,
        pending.target
      );
      markAffiliatePaidIfUnpaid(pending.publisherName, months);
      trySendPaymentConfirmation(
        pending.publisherName,
        pending.amount,
        months,
        "Wise"
      );
      succeeded.push(pending.publisherName);
    } catch (err) {
      failed.push({
        publisherName: pending.publisherName,
        error: err instanceof Error ? err.message : "Wise funding failed",
      });
    }
  }

  console.log(
    `[Payment] Wise bulk pay complete: succeeded=${succeeded.length} failed=${failed.length}`
  );
  res.json({ succeeded, failed });
});

app.post("/api/payment/pay/bulk/billcom", async (req, res) => {
  const publisherNames = parsePublisherNames(req.body);
  if (publisherNames.length === 0) {
    res.status(400).json({ error: "publisherNames array is required" });
    return;
  }

  const months = parsePayMonths(req);
  console.log(
    `[Payment] Bill.com bulk pay request: ${publisherNames.length} affiliate(s) months=${months.join(",")}`
  );

  const succeeded: string[] = [];
  const failed: Array<{ publisherName: string; error: string }> = [];
  const billPayments: Array<{ publisherName: string; billId: string; amount: number }> =
    [];

  for (const publisherName of publisherNames) {
    try {
      const meta = affiliateMetadataFor(publisherName);
      if (!meta || meta.paymentMethod !== "Bill.com") {
        throw new Error("Affiliate is not tagged for Bill.com payments");
      }
      if (isAffiliatePaidForAllMonths(publisherName, months)) {
        throw new Error("Affiliate is already marked paid for the selected month(s)");
      }

      const billcomVendorId = meta.billcomVendorId?.trim() ?? "";
      const achDetails = resolveBillcomAchForPay(meta, null);
      if (!billcomVendorId && !achDetails) {
        throw new Error(
          "No Bill.com vendor ID or ACH details — fill in the edit popup first"
        );
      }

      const { amount } = await resolvePayAmount(publisherName, req);
      const prepared = await prepareBillcomPayout(publisherName, amount, {
        billcomVendorId: billcomVendorId || null,
        achDetails,
      });

      if (prepared.vendorCreated) {
        setAffiliateBillcomVendorId(publisherName, prepared.vendorId);
        console.log(
          `[Payment] Saved new Bill.com vendor ID for ${publisherName}: ${prepared.vendorId}`
        );
      }

      billPayments.push({
        publisherName,
        billId: prepared.billId,
        amount,
      });
    } catch (err) {
      failed.push({
        publisherName,
        error: err instanceof Error ? err.message : "Bill.com bill create failed",
      });
    }
  }

  const bulkItems = billPayments.map((item) => ({
    billId: item.billId,
    amount: item.amount,
  }));
  const bulkResult = await bulkPayBills(bulkItems);
  const paidBillIds = new Set(bulkResult.succeeded.map((item) => item.billId));

  for (const item of billPayments) {
    if (paidBillIds.has(item.billId)) {
      markAffiliatePaidIfUnpaid(item.publisherName, months);
      trySendPaymentConfirmation(
        item.publisherName,
        item.amount,
        months,
        "Bill.com"
      );
      succeeded.push(item.publisherName);
    } else {
      const bulkFailure = bulkResult.failed.find(
        (entry) => entry.billId === item.billId
      );
      failed.push({
        publisherName: item.publisherName,
        error: bulkFailure?.error ?? "Bill.com bulk payment failed",
      });
    }
  }

  for (const bulkFailure of bulkResult.failed) {
    if (!billPayments.some((item) => item.billId === bulkFailure.billId)) {
      failed.push({
        publisherName: bulkFailure.billId,
        error: bulkFailure.error,
      });
    }
  }

  console.log(
    `[Payment] Bill.com bulk pay complete: succeeded=${succeeded.length} failed=${failed.length}`
  );
  res.json({ succeeded, failed });
});

app.get("/api/debug/failed-scrubs", (req, res) => {
  try {
    const callId =
      typeof req.query.callId === "string" ? req.query.callId.trim() : "";

    const db = openDb();
    try {
      const rows = callId
        ? db
            .prepare(
              `SELECT inboundCallId, taskId, publisherName, status, errorMessage, createdAt
               FROM scrub_log
               WHERE inboundCallId = ?
               ORDER BY createdAt ASC`
            )
            .all(callId)
        : db
            .prepare(
              `SELECT inboundCallId, taskId, publisherName, status, errorMessage, createdAt
               FROM scrub_log
               WHERE status NOT IN ('success')
               ORDER BY createdAt DESC
               LIMIT 100`
            )
            .all();
      res.json(rows);
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read failed scrubs",
    });
  }
});

app.post("/jarvis/tts", async (req, res) => {
  const text = sanitizeSpeech(String(req.body?.text || ""));
  if (!text) return res.status(400).json({ error: "text required" });
  const result = await generateTTS(text);
  if (!result) return res.status(500).json({ error: "TTS failed" });
  res.setHeader("Content-Type", "audio/pcm");
  res.setHeader("X-Sample-Rate", String(result.sampleRate));
  res.send(result.pcm);
});

app.post("/api/jarvis/voice", async (req, res) => {
  const text = sanitizeSpeech(String(req.body?.text || ""));
  if (!text) return res.status(400).json({ error: "text required" });
  const result = await generateTTS(text);
  if (!result) return res.status(500).json({ error: "TTS failed" });
  res.setHeader("Content-Type", "audio/pcm");
  res.setHeader("X-Sample-Rate", String(result.sampleRate));
  res.send(result.pcm);
});

app.post("/api/jarvis/voice/command", express.json({ limit: "64kb" }), (req, res) => {
  void handleVoiceCommand(req, res);
});

app.get("/api/jarvis/activation", async (_req, res) => {
  try {
    const packet = await buildMemoryPacketForQuery("activation brief LeadSmart");
    const text = await handleActivation(packet);
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/v1/chat/completions", (req, res) => {
  void handleChatCompletions(req, res);
});

app.post("/api/jarvis/extract", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "jarvis-" + Date.now());
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
    if (transcript.length < 2) {
      res.status(400).json({ error: "transcript must have at least 2 turns" });
      return;
    }
    await runPostConversationExtraction(sessionId, transcript);
    broadcastHullEvent({ type: "memory_updated" });
    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Extraction failed",
    });
  }
});

app.post("/api/memory/extract-voice", express.json({ limit: "512kb" }), async (req, res) => {
  try {
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
    const sessionId =
      typeof req.body?.sessionId === "string"
        ? req.body.sessionId
        : "jarvis-voice-" + Date.now();
    if (transcript.length < 2) {
      res.status(400).json({ error: "transcript must have at least 2 turns" });
      return;
    }
    await runPostConversationExtraction(
      sessionId,
      transcript.map((t: { role?: string; text?: string }) => ({
        role: String(t.role || "user"),
        text: String(t.text || ""),
      }))
    );
    broadcastHullEvent({ type: "memory_updated" });
    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Extraction failed",
    });
  }
});

app.get("/api/memory/overview", (_req, res) => {
  try {
    res.json(getMemoryOverview());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read memory overview",
    });
  }
});

app.get("/api/memory/facts", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ facts: listFacts(limit, q) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list facts",
    });
  }
});

app.get("/api/memory/episodes", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
    res.json({ episodes: listEpisodes(limit) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list episodes",
    });
  }
});

app.get("/api/memory/rules", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
    res.json({ rules: listRules(limit) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list rules",
    });
  }
});

app.get("/api/memory/syntheses", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? "20"), 10) || 20;
    res.json({ syntheses: listSyntheses(limit) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list syntheses",
    });
  }
});

app.get("/api/memory/graph", (req, res) => {
  try {
    const entity =
      typeof req.query.entity === "string" ? req.query.entity.trim() : "";
    if (!entity) {
      res.status(400).json({ error: "entity query required" });
      return;
    }
    res.json(getGraphForEntity(entity));
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read graph",
    });
  }
});

app.get("/api/memory/identity", (_req, res) => {
  try {
    res.json(getMemoryIdentity());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to read identity",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    brain: getOpenAIClient() ? "openai" : "unconfigured",
    model: getChatModel(),
    memory: "ready",
    jarvis: {
      voice: {
        stt: process.env.ELEVENLABS_API_KEY?.trim() ? "elevenlabs-scribe" : "none",
        tts: process.env.ELEVENLABS_API_KEY?.trim() ? "elevenlabs" : "none",
        brain: getOpenAIClient() ? "openai" : "none",
      },
    },
  });
});

app.get("/memory", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "memory.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const server = http.createServer(app);

server.on("upgrade", (request, socket, head) => {
  if (handleDeepgramUpgrade(request, socket, head, (_req) => true)) {
    return;
  }
  if (handleHullEventsUpgrade(request, socket, head)) {
    return;
  }
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  warnMissingPaymentEnvVars();
  console.log(`[Dashboard] listening on 0.0.0.0:${PORT}`);
});
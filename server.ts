import "dotenv/config";
import * as path from "path";
import express from "express";
import Database from "better-sqlite3";
import { ensureScrubLogSchema } from "./lib/logger";
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
} from "./agents/paymentAgent";

import http from "http";
import { WebSocketServer } from "ws";
import { handleDeepgramUpgrade } from "./hull/voice/deepgramProxy";
import { generateTTS } from "./hull/voice/tts";
import { runAgentLoop } from "./hull/brain/agent-loop";

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
      publishers,
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
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  const result = await generateTTS(text);
  if (!result) return res.status(500).json({ error: "TTS failed" });
  res.setHeader("Content-Type", "audio/pcm");
  res.setHeader("X-Sample-Rate", String(result.sampleRate));
  res.send(result.pcm);
});

app.post("/v1/chat/completions", async (req, res) => {
  // Placeholder – will use agent loop from brain
  res.status(501).json({ error: "Not yet integrated – brain layer pending" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: process.env.AETHON_MODEL || "claude-sonnet-4-6", memory: "initializing" });
});

app.get("/memory", (_req, res) => {
  res.status(501).json({ error: "Memory page pending – UI phase" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (handleDeepgramUpgrade(request, socket, head, (_req) => true)) {
    return;
  }
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Dashboard] listening on 0.0.0.0:${PORT}`);
});
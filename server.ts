import * as path from "path";
import express from "express";
import Database from "better-sqlite3";
import { ensureScrubLogSchema } from "./lib/logger";
import { getDataDir, getDbPath, getPublicDir } from "./lib/paths";
import { importDatabaseFile } from "./lib/importDatabase";
import { triggerPollNow } from "./lib/pollScheduler";

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

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Dashboard] listening on 0.0.0.0:${PORT}`);
});

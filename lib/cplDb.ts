import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getDataDir } from "./paths";

/**
 * CPL updater audit store — its own SQLite file (cpl.db). Never opens
 * scrub_log.db or fraud.db. Records every upload batch and per-row result so
 * there is a permanent history of what revenue/payout was written to Ringba.
 */

let db: Database.Database | null = null;

export function getCplDbPath(): string {
  return path.join(getDataDir(), "cpl.db");
}

export function getCplDb(): Database.Database {
  if (db) return db;
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(getCplDbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cpl_batches (
      id TEXT PRIMARY KEY,
      fileName TEXT,
      weekStart TEXT,
      weekEnd TEXT,
      fileRows INTEGER NOT NULL DEFAULT 0,
      ringbaCalls INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0,
      unmatched INTEGER NOT NULL DEFAULT 0,
      stripped INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'preview',
      updated INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      appliedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS cpl_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batchId TEXT NOT NULL,
      action TEXT NOT NULL,
      publisherName TEXT,
      callerId TEXT,
      fileCallerId TEXT,
      callDt TEXT,
      fileTimeEt TEXT,
      target TEXT,
      inboundCallId TEXT,
      costPerLead REAL,
      currentRevenue REAL,
      currentPayout REAL,
      newRevenue REAL,
      newPayout REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      appliedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cpl_rows_batch ON cpl_rows (batchId);
  `);
  return db;
}

export interface CplRowInput {
  action: "set" | "strip" | "no_match";
  publisherName: string | null;
  callerId: string | null;
  fileCallerId: string | null;
  callDt: string | null;
  fileTimeEt: string | null;
  target: string | null;
  inboundCallId: string | null;
  costPerLead: number | null;
  currentRevenue: number | null;
  currentPayout: number | null;
  newRevenue: number | null;
  newPayout: number | null;
}

export interface CplRow extends CplRowInput {
  id: number;
  batchId: string;
  status: string;
  error: string | null;
  appliedAt: string | null;
}

export interface CplBatch {
  id: string;
  fileName: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  fileRows: number;
  ringbaCalls: number;
  matched: number;
  unmatched: number;
  stripped: number;
  status: string;
  updated: number;
  failed: number;
  createdAt: string;
  appliedAt: string | null;
}

export function createBatch(input: {
  fileName: string;
  weekStart: string;
  weekEnd: string;
  fileRows: number;
  ringbaCalls: number;
  rows: CplRowInput[];
}): string {
  const database = getCplDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const matched = input.rows.filter((r) => r.action === "set").length;
  const stripped = input.rows.filter((r) => r.action === "strip").length;
  const unmatched = input.rows.filter((r) => r.action === "no_match").length;

  const insertBatch = database.prepare(
    `INSERT INTO cpl_batches (
       id, fileName, weekStart, weekEnd, fileRows, ringbaCalls,
       matched, unmatched, stripped, status, createdAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?)`,
  );
  const insertRow = database.prepare(
    `INSERT INTO cpl_rows (
       batchId, action, publisherName, callerId, fileCallerId, callDt, fileTimeEt,
       target, inboundCallId, costPerLead, currentRevenue, currentPayout,
       newRevenue, newPayout, status
     ) VALUES (
       @batchId, @action, @publisherName, @callerId, @fileCallerId, @callDt, @fileTimeEt,
       @target, @inboundCallId, @costPerLead, @currentRevenue, @currentPayout,
       @newRevenue, @newPayout, 'pending'
     )`,
  );

  const tx = database.transaction(() => {
    insertBatch.run(
      id,
      input.fileName,
      input.weekStart,
      input.weekEnd,
      input.fileRows,
      input.ringbaCalls,
      matched,
      unmatched,
      stripped,
      now,
    );
    for (const row of input.rows) {
      insertRow.run({ batchId: id, ...row });
    }
  });
  tx();
  return id;
}

export function getBatch(batchId: string): CplBatch | null {
  const row = getCplDb()
    .prepare("SELECT * FROM cpl_batches WHERE id = ?")
    .get(batchId) as CplBatch | undefined;
  return row ?? null;
}

export function listBatches(limit = 30): CplBatch[] {
  return getCplDb()
    .prepare("SELECT * FROM cpl_batches ORDER BY createdAt DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 200)) as CplBatch[];
}

export function getBatchRows(batchId: string): CplRow[] {
  return getCplDb()
    .prepare("SELECT * FROM cpl_rows WHERE batchId = ? ORDER BY id")
    .all(batchId) as CplRow[];
}

/** Rows that actually write to Ringba (set + strip), in a stable order. */
export function getApplicableRows(batchId: string): CplRow[] {
  return getCplDb()
    .prepare(
      "SELECT * FROM cpl_rows WHERE batchId = ? AND action IN ('set','strip') ORDER BY id",
    )
    .all(batchId) as CplRow[];
}

export function markRowResult(
  rowId: number,
  ok: boolean,
  result: { newRevenue?: number; newPayout?: number; error?: string },
): void {
  getCplDb()
    .prepare(
      `UPDATE cpl_rows
       SET status = ?, error = ?, appliedAt = ?,
           newRevenue = COALESCE(?, newRevenue),
           newPayout = COALESCE(?, newPayout)
       WHERE id = ?`,
    )
    .run(
      ok ? "updated" : "failed",
      result.error ?? null,
      new Date().toISOString(),
      result.newRevenue ?? null,
      result.newPayout ?? null,
      rowId,
    );
}

export function finalizeBatch(
  batchId: string,
  updated: number,
  failed: number,
): void {
  getCplDb()
    .prepare(
      `UPDATE cpl_batches SET status = 'applied', updated = ?, failed = ?, appliedAt = ? WHERE id = ?`,
    )
    .run(updated, failed, new Date().toISOString(), batchId);
}

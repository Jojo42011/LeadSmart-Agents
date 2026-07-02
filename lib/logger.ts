import Database from "better-sqlite3";
import * as fs from "fs";
import { getDataDir, getDbPath } from "./paths";


/** Row written to scrub_log. */
export interface ScrubLogEntry {
  id?: number;
  taskId?: string | null;
  inboundCallId: string;
  publisherName?: string | null;
  amountVoided?: number | null;
  voidPayoutAmount?: number | null;
  voidConversionAmount?: number | null;
  status:
    | "success"
    | "error"
    | "dry_run"
    | "skipped"
    | "void_success_approve_failed";
  errorMessage?: string | null;
  createdAt: string;
}

let db: Database.Database | null = null;

function migrateAffiliateMetadataSchema(database: Database.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(affiliate_metadata)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("billcomVendorId")) {
    database.exec("ALTER TABLE affiliate_metadata ADD COLUMN billcomVendorId TEXT");
  }
}

function migrateScrubLogSchema(database: Database.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(scrub_log)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("voidPayoutAmount")) {
    database.exec("ALTER TABLE scrub_log ADD COLUMN voidPayoutAmount REAL");
  }
  if (!names.has("voidConversionAmount")) {
    database.exec("ALTER TABLE scrub_log ADD COLUMN voidConversionAmount REAL");
  }
}

/**
 * Opens (or creates) the SQLite database and ensures tables exist.
 */
function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const dataDir = getDataDir();
  const dbPath = getDbPath();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scrub_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT,
      inboundCallId TEXT NOT NULL,
      publisherName TEXT,
      amountVoided REAL,
      status TEXT NOT NULL,
      errorMessage TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scrub_log_inbound_call_id
      ON scrub_log (inboundCallId);

    CREATE INDEX IF NOT EXISTS idx_scrub_log_status
      ON scrub_log (status);

    CREATE TABLE IF NOT EXISTS poll_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lastSuccessfulPollAt TEXT
    );

    CREATE TABLE IF NOT EXISTS affiliate_metadata (
      publisherName TEXT PRIMARY KEY,
      paymentMethod TEXT,
      paymentTerms TEXT,
      isPaid INTEGER DEFAULT 0,
      paidAt TEXT,
      updatedAt TEXT,
      billcomVendorId TEXT
    );

    CREATE TABLE IF NOT EXISTS billcom_mfa (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      deviceId TEXT NOT NULL,
      mfaId TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  const row = db
    .prepare("SELECT lastSuccessfulPollAt FROM poll_state WHERE id = 1")
    .get() as { lastSuccessfulPollAt: string | null } | undefined;

  if (!row) {
    db.prepare(
      "INSERT INTO poll_state (id, lastSuccessfulPollAt) VALUES (1, NULL)"
    ).run();
  }

  migrateScrubLogSchema(db);
  migrateAffiliateMetadataSchema(db);

  return db;
}

/** Ensures tables/columns exist (call on app startup). */
export function ensureScrubLogSchema(): void {
  getDb();
}

/** Closes the pooled connection (e.g. before replacing the database file). */
export function closeDbConnection(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Inserts one scrub action row.
 */
export function logScrub(entry: Omit<ScrubLogEntry, "id" | "createdAt"> & {
  createdAt?: string;
}): void {
  const database = getDb();
  const createdAt = entry.createdAt ?? new Date().toISOString();

  database
    .prepare(
      `INSERT INTO scrub_log (
        taskId, inboundCallId, publisherName, amountVoided,
        voidPayoutAmount, voidConversionAmount,
        status, errorMessage, createdAt
      ) VALUES (
        @taskId, @inboundCallId, @publisherName, @amountVoided,
        @voidPayoutAmount, @voidConversionAmount,
        @status, @errorMessage, @createdAt
      )`
    )
    .run({
      taskId: entry.taskId ?? null,
      inboundCallId: entry.inboundCallId,
      publisherName: entry.publisherName ?? null,
      amountVoided: entry.amountVoided ?? null,
      voidPayoutAmount: entry.voidPayoutAmount ?? null,
      voidConversionAmount: entry.voidConversionAmount ?? null,
      status: entry.status,
      errorMessage: entry.errorMessage ?? null,
      createdAt,
    });
}

/**
 * Returns the most recent scrub log rows, newest first.
 */
export function getRecentLogs(limit: number): ScrubLogEntry[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, taskId, inboundCallId, publisherName, amountVoided,
              voidPayoutAmount, voidConversionAmount,
              status, errorMessage, createdAt
       FROM scrub_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as ScrubLogEntry[];

  return rows;
}

/**
 * Returns true if this call was fully scrubbed (approve succeeded).
 */
export function wasSuccessfullyProcessed(inboundCallId: string): boolean {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT 1 FROM scrub_log
       WHERE inboundCallId = ?
         AND status = 'success'
       LIMIT 1`
    )
    .get(inboundCallId);

  return row !== undefined;
}

/**
 * ISO timestamp of the last fully successful poll cycle, or null if never set.
 */
export function getLastSuccessfulPollAt(): string | null {
  const database = getDb();
  const row = database
    .prepare("SELECT lastSuccessfulPollAt FROM poll_state WHERE id = 1")
    .get() as { lastSuccessfulPollAt: string | null };

  return row.lastSuccessfulPollAt ?? null;
}

/**
 * Persists the timestamp of the last successful poll cycle.
 */
export function setLastSuccessfulPollAt(isoTimestamp: string): void {
  const database = getDb();
  database
    .prepare(
      "UPDATE poll_state SET lastSuccessfulPollAt = ? WHERE id = 1"
    )
    .run(isoTimestamp);
}

/** Affiliate payment tagging and paid status (payment portal). */
export interface AffiliateMetadata {
  paymentMethod: string | null;
  paymentTerms: string | null;
  isPaid: boolean;
  paidAt: string | null;
  updatedAt: string | null;
  billcomVendorId: string | null;
}

type AffiliateMetadataRow = {
  publisherName: string;
  paymentMethod: string | null;
  paymentTerms: string | null;
  isPaid: number;
  paidAt: string | null;
  updatedAt: string | null;
  billcomVendorId: string | null;
};

function rowToAffiliateMetadata(row: AffiliateMetadataRow): AffiliateMetadata {
  return {
    paymentMethod: row.paymentMethod,
    paymentTerms: row.paymentTerms,
    isPaid: row.isPaid === 1,
    paidAt: row.paidAt,
    updatedAt: row.updatedAt,
    billcomVendorId: row.billcomVendorId,
  };
}

/** Returns all affiliate metadata keyed by publisher name. */
export function getAllAffiliateMetadata(): Record<string, AffiliateMetadata> {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId
       FROM affiliate_metadata`
    )
    .all() as AffiliateMetadataRow[];

  const map: Record<string, AffiliateMetadata> = {};
  for (const row of rows) {
    map[row.publisherName] = rowToAffiliateMetadata(row);
  }
  return map;
}

/** Upserts payment method, terms, and Bill.com vendor ID for one affiliate. */
export function upsertAffiliateMetadata(
  publisherName: string,
  paymentMethod: string | null,
  paymentTerms: string | null,
  billcomVendorId: string | null = null
): AffiliateMetadata {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  const existing = database
    .prepare(
      "SELECT publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId FROM affiliate_metadata WHERE publisherName = ?"
    )
    .get(publisherName) as AffiliateMetadataRow | undefined;

  if (existing) {
    database
      .prepare(
        `UPDATE affiliate_metadata
         SET paymentMethod = ?, paymentTerms = ?, billcomVendorId = ?, updatedAt = ?
         WHERE publisherName = ?`
      )
      .run(paymentMethod, paymentTerms, billcomVendorId, updatedAt, publisherName);
  } else {
    database
      .prepare(
        `INSERT INTO affiliate_metadata (
          publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId
        ) VALUES (?, ?, ?, 0, NULL, ?, ?)`
      )
      .run(publisherName, paymentMethod, paymentTerms, updatedAt, billcomVendorId);
  }

  const row = database
    .prepare(
      "SELECT publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId FROM affiliate_metadata WHERE publisherName = ?"
    )
    .get(publisherName) as AffiliateMetadataRow;

  return rowToAffiliateMetadata(row);
}

/** Toggles paid status for one affiliate; sets paidAt when marking paid. */
export function toggleAffiliatePaid(publisherName: string): AffiliateMetadata {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  const existing = database
    .prepare(
      "SELECT publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId FROM affiliate_metadata WHERE publisherName = ?"
    )
    .get(publisherName) as AffiliateMetadataRow | undefined;

  if (!existing) {
    const paidAt = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO affiliate_metadata (
          publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId
        ) VALUES (?, NULL, NULL, 1, ?, ?, NULL)`
      )
      .run(publisherName, paidAt, updatedAt);

    return {
      paymentMethod: null,
      paymentTerms: null,
      isPaid: true,
      paidAt,
      updatedAt,
      billcomVendorId: null,
    };
  }

  const nextPaid = existing.isPaid === 1 ? 0 : 1;
  const paidAt = nextPaid === 1 ? new Date().toISOString() : null;

  database
    .prepare(
      `UPDATE affiliate_metadata
       SET isPaid = ?, paidAt = ?, updatedAt = ?
       WHERE publisherName = ?`
    )
    .run(nextPaid, paidAt, updatedAt, publisherName);

  return {
    paymentMethod: existing.paymentMethod,
    paymentTerms: existing.paymentTerms,
    isPaid: nextPaid === 1,
    paidAt,
    updatedAt,
    billcomVendorId: existing.billcomVendorId,
  };
}

export interface BillcomMfaCredentials {
  deviceId: string;
  mfaId: string;
  updatedAt: string;
}

/** Returns persisted Bill.com MFA trust (30-day rememberMe), if any. */
export function getBillcomMfaCredentials(): BillcomMfaCredentials | null {
  const database = getDb();
  const row = database
    .prepare("SELECT deviceId, mfaId, updatedAt FROM billcom_mfa WHERE id = 1")
    .get() as { deviceId: string; mfaId: string; updatedAt: string } | undefined;
  if (!row?.deviceId || !row.mfaId) {
    return null;
  }
  return row;
}

/** Saves Bill.com MFA trust after successful MFAAuthenticate (rememberMe). */
export function saveBillcomMfaCredentials(deviceId: string, mfaId: string): void {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO billcom_mfa (id, deviceId, mfaId, updatedAt)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         deviceId = excluded.deviceId,
         mfaId = excluded.mfaId,
         updatedAt = excluded.updatedAt`
    )
    .run(deviceId, mfaId, updatedAt);
  console.log(
    "[BillCom] Saved MFA trust to database (deviceId=%s, updatedAt=%s)",
    deviceId,
    updatedAt
  );
}

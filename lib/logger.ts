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

const BILLCOM_ACH_COLUMNS = [
  "billcomPayeeName",
  "billcomAccountHolderName",
  "billcomRoutingNumber",
  "billcomAccountNumber",
  "billcomAddressLine1",
  "billcomAddressCity",
  "billcomAddressState",
  "billcomAddressZip",
] as const;

const WISE_IDENTIFIER_COLUMNS = ["wiseEmail", "wiseTag", "wiseRecipientId"] as const;

const WISE_ACH_COLUMNS = [
  "wiseAccountHolderName",
  "wiseRoutingNumber",
  "wiseAccountNumber",
  "wiseAddressLine1",
  "wiseAddressCity",
  "wiseAddressState",
  "wiseAddressZip",
] as const;

function migrateAffiliateMetadataSchema(database: Database.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(affiliate_metadata)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("billcomVendorId")) {
    database.exec("ALTER TABLE affiliate_metadata ADD COLUMN billcomVendorId TEXT");
  }
  for (const column of BILLCOM_ACH_COLUMNS) {
    if (!names.has(column)) {
      database.exec(`ALTER TABLE affiliate_metadata ADD COLUMN ${column} TEXT`);
    }
  }
  for (const column of WISE_IDENTIFIER_COLUMNS) {
    if (!names.has(column)) {
      database.exec(`ALTER TABLE affiliate_metadata ADD COLUMN ${column} TEXT`);
    }
  }
  for (const column of WISE_ACH_COLUMNS) {
    if (!names.has(column)) {
      database.exec(`ALTER TABLE affiliate_metadata ADD COLUMN ${column} TEXT`);
    }
  }
  if (!names.has("paymentEmail")) {
    database.exec("ALTER TABLE affiliate_metadata ADD COLUMN paymentEmail TEXT");
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

    CREATE TABLE IF NOT EXISTS affiliate_paid_months (
      publisherName TEXT NOT NULL,
      month TEXT NOT NULL,
      paidAt TEXT NOT NULL,
      PRIMARY KEY (publisherName, month)
    );

    CREATE INDEX IF NOT EXISTS idx_affiliate_paid_months_month
      ON affiliate_paid_months (month);
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
  migrateLegacyPaidToMonths(db);

  return db;
}

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function monthKeyFromIso(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (!year || !month) {
    return null;
  }
  return `${year}-${month}`;
}

/** One-time backfill: global isPaid rows → affiliate_paid_months by paidAt month. */
function migrateLegacyPaidToMonths(database: Database.Database): void {
  const rows = database
    .prepare(
      `SELECT publisherName, paidAt FROM affiliate_metadata
       WHERE isPaid = 1 AND paidAt IS NOT NULL`
    )
    .all() as Array<{ publisherName: string; paidAt: string }>;

  const insert = database.prepare(
    `INSERT OR IGNORE INTO affiliate_paid_months (publisherName, month, paidAt)
     VALUES (?, ?, ?)`
  );

  for (const row of rows) {
    const month = monthKeyFromIso(row.paidAt);
    if (month) {
      insert.run(row.publisherName, month, row.paidAt);
    }
  }
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
  /** Paid months keyed by YYYY-MM → paidAt ISO timestamp. */
  paidMonths: Record<string, string>;
  isPaid: boolean;
  paidAt: string | null;
  updatedAt: string | null;
  billcomVendorId: string | null;
  billcomPayeeName: string | null;
  billcomAccountHolderName: string | null;
  billcomRoutingNumber: string | null;
  billcomAccountNumber: string | null;
  billcomAddressLine1: string | null;
  billcomAddressCity: string | null;
  billcomAddressState: string | null;
  billcomAddressZip: string | null;
  wiseEmail: string | null;
  wiseTag: string | null;
  wiseRecipientId: string | null;
  wiseAccountHolderName: string | null;
  wiseRoutingNumber: string | null;
  wiseAccountNumber: string | null;
  wiseAddressLine1: string | null;
  wiseAddressCity: string | null;
  wiseAddressState: string | null;
  wiseAddressZip: string | null;
  paymentEmail: string | null;
}

export type BillcomAchFieldUpdates = {
  billcomPayeeName?: string | null;
  billcomAccountHolderName?: string | null;
  billcomRoutingNumber?: string | null;
  billcomAccountNumber?: string | null;
  billcomAddressLine1?: string | null;
  billcomAddressCity?: string | null;
  billcomAddressState?: string | null;
  billcomAddressZip?: string | null;
};

export type WiseFieldUpdates = {
  wiseEmail?: string | null;
  wiseTag?: string | null;
  wiseRecipientId?: string | null;
  wiseAccountHolderName?: string | null;
  wiseRoutingNumber?: string | null;
  wiseAccountNumber?: string | null;
  wiseAddressLine1?: string | null;
  wiseAddressCity?: string | null;
  wiseAddressState?: string | null;
  wiseAddressZip?: string | null;
};

type AffiliateMetadataRow = {
  publisherName: string;
  paymentMethod: string | null;
  paymentTerms: string | null;
  isPaid: number;
  paidAt: string | null;
  updatedAt: string | null;
  billcomVendorId: string | null;
  billcomPayeeName: string | null;
  billcomAccountHolderName: string | null;
  billcomRoutingNumber: string | null;
  billcomAccountNumber: string | null;
  billcomAddressLine1: string | null;
  billcomAddressCity: string | null;
  billcomAddressState: string | null;
  billcomAddressZip: string | null;
  wiseEmail: string | null;
  wiseTag: string | null;
  wiseRecipientId: string | null;
  wiseAccountHolderName: string | null;
  wiseRoutingNumber: string | null;
  wiseAccountNumber: string | null;
  wiseAddressLine1: string | null;
  wiseAddressCity: string | null;
  wiseAddressState: string | null;
  wiseAddressZip: string | null;
  paymentEmail: string | null;
};

const AFFILIATE_METADATA_SELECT =
  `SELECT publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt,
          billcomVendorId, billcomPayeeName, billcomAccountHolderName,
          billcomRoutingNumber, billcomAccountNumber, billcomAddressLine1,
          billcomAddressCity, billcomAddressState, billcomAddressZip,
          wiseEmail, wiseTag, wiseRecipientId, wiseAccountHolderName, wiseRoutingNumber,
          wiseAccountNumber, wiseAddressLine1, wiseAddressCity, wiseAddressState,
          wiseAddressZip, paymentEmail
   FROM affiliate_metadata`;

function loadPaidMonthsMap(
  database: Database.Database
): Record<string, Record<string, string>> {
  const rows = database
    .prepare(
      `SELECT publisherName, month, paidAt FROM affiliate_paid_months ORDER BY month`
    )
    .all() as Array<{ publisherName: string; month: string; paidAt: string }>;

  const map: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (!map[row.publisherName]) {
      map[row.publisherName] = {};
    }
    map[row.publisherName][row.month] = row.paidAt;
  }
  return map;
}

function rowToAffiliateMetadata(
  row: AffiliateMetadataRow,
  paidMonths: Record<string, string> = {}
): AffiliateMetadata {
  return {
    paymentMethod: row.paymentMethod,
    paymentTerms: row.paymentTerms,
    paidMonths,
    isPaid: row.isPaid === 1,
    paidAt: row.paidAt,
    updatedAt: row.updatedAt,
    billcomVendorId: row.billcomVendorId,
    billcomPayeeName: row.billcomPayeeName,
    billcomAccountHolderName: row.billcomAccountHolderName,
    billcomRoutingNumber: row.billcomRoutingNumber,
    billcomAccountNumber: row.billcomAccountNumber,
    billcomAddressLine1: row.billcomAddressLine1,
    billcomAddressCity: row.billcomAddressCity,
    billcomAddressState: row.billcomAddressState,
    billcomAddressZip: row.billcomAddressZip,
    wiseEmail: row.wiseEmail,
    wiseTag: row.wiseTag,
    wiseRecipientId: row.wiseRecipientId,
    wiseAccountHolderName: row.wiseAccountHolderName,
    wiseRoutingNumber: row.wiseRoutingNumber,
    wiseAccountNumber: row.wiseAccountNumber,
    wiseAddressLine1: row.wiseAddressLine1,
    wiseAddressCity: row.wiseAddressCity,
    wiseAddressState: row.wiseAddressState,
    wiseAddressZip: row.wiseAddressZip,
    paymentEmail: row.paymentEmail,
  };
}

/** Returns all affiliate metadata keyed by publisher name. */
export function getAllAffiliateMetadata(): Record<string, AffiliateMetadata> {
  const database = getDb();
  const paidByPublisher = loadPaidMonthsMap(database);
  const rows = database
    .prepare(`${AFFILIATE_METADATA_SELECT}`)
    .all() as AffiliateMetadataRow[];

  const map: Record<string, AffiliateMetadata> = {};
  for (const row of rows) {
    map[row.publisherName] = rowToAffiliateMetadata(
      row,
      paidByPublisher[row.publisherName] ?? {}
    );
  }
  return map;
}

export function isAffiliatePaidForMonth(
  publisherName: string,
  month: string
): boolean {
  if (!MONTH_KEY_RE.test(month)) {
    return false;
  }
  const database = getDb();
  const row = database
    .prepare(
      `SELECT 1 FROM affiliate_paid_months
       WHERE publisherName = ? AND month = ? LIMIT 1`
    )
    .get(publisherName, month);
  return row !== undefined;
}

export function getAffiliatePaidAtForMonth(
  publisherName: string,
  month: string
): string | null {
  if (!MONTH_KEY_RE.test(month)) {
    return null;
  }
  const database = getDb();
  const row = database
    .prepare(
      `SELECT paidAt FROM affiliate_paid_months
       WHERE publisherName = ? AND month = ?`
    )
    .get(publisherName, month) as { paidAt: string } | undefined;
  return row?.paidAt ?? null;
}

/** Marks an affiliate paid for one or more YYYY-MM months (skips already-paid months). */
export function markAffiliatePaidForMonths(
  publisherName: string,
  months: string[]
): void {
  const database = getDb();
  const uniqueMonths = [...new Set(months.filter((m) => MONTH_KEY_RE.test(m)))];
  if (uniqueMonths.length === 0) {
    return;
  }

  const paidAt = new Date().toISOString();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO affiliate_paid_months (publisherName, month, paidAt)
     VALUES (?, ?, ?)`
  );

  for (const month of uniqueMonths) {
    insert.run(publisherName, month, paidAt);
  }
}

/** Toggles paid status for one affiliate for a specific month. */
export function toggleAffiliatePaidForMonth(
  publisherName: string,
  month: string
): { paid: boolean; paidAt: string | null; paidMonths: Record<string, string> } {
  if (!MONTH_KEY_RE.test(month)) {
    throw new Error("month must be YYYY-MM");
  }

  const database = getDb();
  const existing = database
    .prepare(
      `SELECT paidAt FROM affiliate_paid_months
       WHERE publisherName = ? AND month = ?`
    )
    .get(publisherName, month) as { paidAt: string } | undefined;

  if (existing) {
    database
      .prepare(
        `DELETE FROM affiliate_paid_months WHERE publisherName = ? AND month = ?`
      )
      .run(publisherName, month);
  } else {
    const paidAt = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO affiliate_paid_months (publisherName, month, paidAt)
         VALUES (?, ?, ?)`
      )
      .run(publisherName, month, paidAt);
  }

  const paidByPublisher = loadPaidMonthsMap(database);
  const paidMonths = paidByPublisher[publisherName] ?? {};
  const paidAt = paidMonths[month] ?? null;
  return { paid: paidAt !== null, paidAt, paidMonths };
}

/** Upserts payment method, terms, Bill.com vendor ID, and optional ACH fields. */
export function upsertAffiliateMetadata(
  publisherName: string,
  paymentMethod: string | null,
  paymentTerms: string | null,
  billcomVendorId: string | null = null,
  billcomAch: BillcomAchFieldUpdates | null = null,
  wiseFields: WiseFieldUpdates | null = null,
  paymentEmail: string | null | undefined = undefined
): AffiliateMetadata {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  const existing = database
    .prepare(`${AFFILIATE_METADATA_SELECT} WHERE publisherName = ?`)
    .get(publisherName) as AffiliateMetadataRow | undefined;

  const nextAch = billcomAch
    ? {
        billcomPayeeName:
          billcomAch.billcomPayeeName !== undefined
            ? billcomAch.billcomPayeeName
            : existing?.billcomPayeeName ?? null,
        billcomAccountHolderName:
          billcomAch.billcomAccountHolderName !== undefined
            ? billcomAch.billcomAccountHolderName
            : existing?.billcomAccountHolderName ?? null,
        billcomRoutingNumber:
          billcomAch.billcomRoutingNumber !== undefined
            ? billcomAch.billcomRoutingNumber
            : existing?.billcomRoutingNumber ?? null,
        billcomAccountNumber:
          billcomAch.billcomAccountNumber !== undefined
            ? billcomAch.billcomAccountNumber
            : existing?.billcomAccountNumber ?? null,
        billcomAddressLine1:
          billcomAch.billcomAddressLine1 !== undefined
            ? billcomAch.billcomAddressLine1
            : existing?.billcomAddressLine1 ?? null,
        billcomAddressCity:
          billcomAch.billcomAddressCity !== undefined
            ? billcomAch.billcomAddressCity
            : existing?.billcomAddressCity ?? null,
        billcomAddressState:
          billcomAch.billcomAddressState !== undefined
            ? billcomAch.billcomAddressState
            : existing?.billcomAddressState ?? null,
        billcomAddressZip:
          billcomAch.billcomAddressZip !== undefined
            ? billcomAch.billcomAddressZip
            : existing?.billcomAddressZip ?? null,
      }
    : {
        billcomPayeeName: existing?.billcomPayeeName ?? null,
        billcomAccountHolderName: existing?.billcomAccountHolderName ?? null,
        billcomRoutingNumber: existing?.billcomRoutingNumber ?? null,
        billcomAccountNumber: existing?.billcomAccountNumber ?? null,
        billcomAddressLine1: existing?.billcomAddressLine1 ?? null,
        billcomAddressCity: existing?.billcomAddressCity ?? null,
        billcomAddressState: existing?.billcomAddressState ?? null,
        billcomAddressZip: existing?.billcomAddressZip ?? null,
      };

  const nextWise = wiseFields
    ? {
        wiseEmail:
          wiseFields.wiseEmail !== undefined
            ? wiseFields.wiseEmail
            : existing?.wiseEmail ?? null,
        wiseTag:
          wiseFields.wiseTag !== undefined
            ? wiseFields.wiseTag
            : existing?.wiseTag ?? null,
        wiseRecipientId:
          wiseFields.wiseRecipientId !== undefined
            ? wiseFields.wiseRecipientId
            : existing?.wiseRecipientId ?? null,
        wiseAccountHolderName:
          wiseFields.wiseAccountHolderName !== undefined
            ? wiseFields.wiseAccountHolderName
            : existing?.wiseAccountHolderName ?? null,
        wiseRoutingNumber:
          wiseFields.wiseRoutingNumber !== undefined
            ? wiseFields.wiseRoutingNumber
            : existing?.wiseRoutingNumber ?? null,
        wiseAccountNumber:
          wiseFields.wiseAccountNumber !== undefined
            ? wiseFields.wiseAccountNumber
            : existing?.wiseAccountNumber ?? null,
        wiseAddressLine1:
          wiseFields.wiseAddressLine1 !== undefined
            ? wiseFields.wiseAddressLine1
            : existing?.wiseAddressLine1 ?? null,
        wiseAddressCity:
          wiseFields.wiseAddressCity !== undefined
            ? wiseFields.wiseAddressCity
            : existing?.wiseAddressCity ?? null,
        wiseAddressState:
          wiseFields.wiseAddressState !== undefined
            ? wiseFields.wiseAddressState
            : existing?.wiseAddressState ?? null,
        wiseAddressZip:
          wiseFields.wiseAddressZip !== undefined
            ? wiseFields.wiseAddressZip
            : existing?.wiseAddressZip ?? null,
      }
    : {
        wiseEmail: existing?.wiseEmail ?? null,
        wiseTag: existing?.wiseTag ?? null,
        wiseRecipientId: existing?.wiseRecipientId ?? null,
        wiseAccountHolderName: existing?.wiseAccountHolderName ?? null,
        wiseRoutingNumber: existing?.wiseRoutingNumber ?? null,
        wiseAccountNumber: existing?.wiseAccountNumber ?? null,
        wiseAddressLine1: existing?.wiseAddressLine1 ?? null,
        wiseAddressCity: existing?.wiseAddressCity ?? null,
        wiseAddressState: existing?.wiseAddressState ?? null,
        wiseAddressZip: existing?.wiseAddressZip ?? null,
      };

  const nextPaymentEmail =
    paymentEmail !== undefined ? paymentEmail : existing?.paymentEmail ?? null;

  if (existing) {
    database
      .prepare(
        `UPDATE affiliate_metadata
         SET paymentMethod = ?, paymentTerms = ?, billcomVendorId = ?,
             billcomPayeeName = ?, billcomAccountHolderName = ?,
             billcomRoutingNumber = ?, billcomAccountNumber = ?,
             billcomAddressLine1 = ?, billcomAddressCity = ?,
             billcomAddressState = ?, billcomAddressZip = ?,
             wiseEmail = ?, wiseTag = ?, wiseRecipientId = ?,
             wiseAccountHolderName = ?, wiseRoutingNumber = ?, wiseAccountNumber = ?,
             wiseAddressLine1 = ?, wiseAddressCity = ?, wiseAddressState = ?, wiseAddressZip = ?,
             paymentEmail = ?,
             updatedAt = ?
         WHERE publisherName = ?`
      )
      .run(
        paymentMethod,
        paymentTerms,
        billcomVendorId,
        nextAch.billcomPayeeName,
        nextAch.billcomAccountHolderName,
        nextAch.billcomRoutingNumber,
        nextAch.billcomAccountNumber,
        nextAch.billcomAddressLine1,
        nextAch.billcomAddressCity,
        nextAch.billcomAddressState,
        nextAch.billcomAddressZip,
        nextWise.wiseEmail,
        nextWise.wiseTag,
        nextWise.wiseRecipientId,
        nextWise.wiseAccountHolderName,
        nextWise.wiseRoutingNumber,
        nextWise.wiseAccountNumber,
        nextWise.wiseAddressLine1,
        nextWise.wiseAddressCity,
        nextWise.wiseAddressState,
        nextWise.wiseAddressZip,
        nextPaymentEmail,
        updatedAt,
        publisherName
      );
  } else {
    database
      .prepare(
        `INSERT INTO affiliate_metadata (
          publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt,
          billcomVendorId, billcomPayeeName, billcomAccountHolderName,
          billcomRoutingNumber, billcomAccountNumber, billcomAddressLine1,
          billcomAddressCity, billcomAddressState, billcomAddressZip,
          wiseEmail, wiseTag, wiseRecipientId, wiseAccountHolderName, wiseRoutingNumber,
          wiseAccountNumber, wiseAddressLine1, wiseAddressCity, wiseAddressState,
          wiseAddressZip, paymentEmail
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        publisherName,
        paymentMethod,
        paymentTerms,
        updatedAt,
        billcomVendorId,
        nextAch.billcomPayeeName,
        nextAch.billcomAccountHolderName,
        nextAch.billcomRoutingNumber,
        nextAch.billcomAccountNumber,
        nextAch.billcomAddressLine1,
        nextAch.billcomAddressCity,
        nextAch.billcomAddressState,
        nextAch.billcomAddressZip,
        nextWise.wiseEmail,
        nextWise.wiseTag,
        nextWise.wiseRecipientId,
        nextWise.wiseAccountHolderName,
        nextWise.wiseRoutingNumber,
        nextWise.wiseAccountNumber,
        nextWise.wiseAddressLine1,
        nextWise.wiseAddressCity,
        nextWise.wiseAddressState,
        nextWise.wiseAddressZip,
        nextPaymentEmail
      );
  }

  const row = database
    .prepare(`${AFFILIATE_METADATA_SELECT} WHERE publisherName = ?`)
    .get(publisherName) as AffiliateMetadataRow;

  const paidByPublisher = loadPaidMonthsMap(database);
  return rowToAffiliateMetadata(row, paidByPublisher[publisherName] ?? {});
}

/** Updates only the Bill.com vendor ID, preserving other metadata. */
export function setAffiliateBillcomVendorId(
  publisherName: string,
  billcomVendorId: string
): AffiliateMetadata {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  const existing = database
    .prepare(`${AFFILIATE_METADATA_SELECT} WHERE publisherName = ?`)
    .get(publisherName) as AffiliateMetadataRow | undefined;

  if (existing) {
    database
      .prepare(
        `UPDATE affiliate_metadata SET billcomVendorId = ?, updatedAt = ? WHERE publisherName = ?`
      )
      .run(billcomVendorId, updatedAt, publisherName);
  } else {
    database
      .prepare(
        `INSERT INTO affiliate_metadata (
          publisherName, paymentMethod, paymentTerms, isPaid, paidAt, updatedAt, billcomVendorId
        ) VALUES (?, 'Bill.com', NULL, 0, NULL, ?, ?)`
      )
      .run(publisherName, updatedAt, billcomVendorId);
  }

  const row = database
    .prepare(`${AFFILIATE_METADATA_SELECT} WHERE publisherName = ?`)
    .get(publisherName) as AffiliateMetadataRow;

  const paidByPublisher = loadPaidMonthsMap(database);
  return rowToAffiliateMetadata(row, paidByPublisher[publisherName] ?? {});
}

/** @deprecated Use toggleAffiliatePaidForMonth — legacy global toggle. */
export function toggleAffiliatePaid(publisherName: string): AffiliateMetadata {
  const database = getDb();
  const updatedAt = new Date().toISOString();
  const existing = database
    .prepare(`${AFFILIATE_METADATA_SELECT} WHERE publisherName = ?`)
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
      paidMonths: {},
      isPaid: true,
      paidAt,
      updatedAt,
      billcomVendorId: null,
      billcomPayeeName: null,
      billcomAccountHolderName: null,
      billcomRoutingNumber: null,
      billcomAccountNumber: null,
      billcomAddressLine1: null,
      billcomAddressCity: null,
      billcomAddressState: null,
      billcomAddressZip: null,
      wiseEmail: null,
      wiseTag: null,
      wiseRecipientId: null,
      wiseAccountHolderName: null,
      wiseRoutingNumber: null,
      wiseAccountNumber: null,
      wiseAddressLine1: null,
      wiseAddressCity: null,
      wiseAddressState: null,
      wiseAddressZip: null,
      paymentEmail: null,
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

  const paidByPublisher = loadPaidMonthsMap(database);
  return {
    paymentMethod: existing.paymentMethod,
    paymentTerms: existing.paymentTerms,
    paidMonths: paidByPublisher[publisherName] ?? {},
    isPaid: nextPaid === 1,
    paidAt,
    updatedAt,
    billcomVendorId: existing.billcomVendorId,
    billcomPayeeName: existing.billcomPayeeName,
    billcomAccountHolderName: existing.billcomAccountHolderName,
    billcomRoutingNumber: existing.billcomRoutingNumber,
    billcomAccountNumber: existing.billcomAccountNumber,
    billcomAddressLine1: existing.billcomAddressLine1,
    billcomAddressCity: existing.billcomAddressCity,
    billcomAddressState: existing.billcomAddressState,
    billcomAddressZip: existing.billcomAddressZip,
    wiseEmail: existing.wiseEmail,
    wiseTag: existing.wiseTag,
    wiseRecipientId: existing.wiseRecipientId,
    wiseAccountHolderName: existing.wiseAccountHolderName,
    wiseRoutingNumber: existing.wiseRoutingNumber,
    wiseAccountNumber: existing.wiseAccountNumber,
    wiseAddressLine1: existing.wiseAddressLine1,
    wiseAddressCity: existing.wiseAddressCity,
    wiseAddressState: existing.wiseAddressState,
    wiseAddressZip: existing.wiseAddressZip,
    paymentEmail: existing.paymentEmail,
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

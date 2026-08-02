import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./paths";

/**
 * System 3 fraud data lives in its own SQLite file (fraud.db) so nothing here
 * can ever touch scrub_log.db (scrub + payments).
 */

let db: Database.Database | null = null;

export function getFraudDbPath(): string {
  return path.join(getDataDir(), "fraud.db");
}

export function getFraudDb(): Database.Database {
  if (db) {
    return db;
  }

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(getFraudDbPath());
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_calls (
      inboundCallId TEXT PRIMARY KEY,
      processedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phone_intel (
      phoneNumber TEXT PRIMARY KEY,
      fetchedAt TEXT NOT NULL,
      fraudScore INTEGER,
      lineType TEXT,
      voip INTEGER,
      risky INTEGER,
      recentAbuse INTEGER,
      spammer INTEGER,
      valid INTEGER,
      carrier TEXT,
      country TEXT,
      city TEXT,
      region TEXT,
      raw TEXT
    );

    CREATE TABLE IF NOT EXISTS caller_index (
      callerNumber TEXT NOT NULL,
      publisherName TEXT NOT NULL,
      callCount INTEGER NOT NULL DEFAULT 0,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      PRIMARY KEY (callerNumber, publisherName)
    );

    CREATE INDEX IF NOT EXISTS idx_caller_index_number
      ON caller_index (callerNumber);

    CREATE TABLE IF NOT EXISTS flagged_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inboundCallId TEXT NOT NULL,
      publisherName TEXT NOT NULL,
      callerNumber TEXT,
      callDt TEXT,
      reason TEXT NOT NULL,
      severity INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      createdAt TEXT NOT NULL,
      UNIQUE (inboundCallId, reason)
    );

    CREATE INDEX IF NOT EXISTS idx_flagged_calls_publisher
      ON flagged_calls (publisherName);
    CREATE INDEX IF NOT EXISTS idx_flagged_calls_created
      ON flagged_calls (createdAt DESC);

    CREATE TABLE IF NOT EXISTS publisher_fraud (
      publisherName TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'clear',
      riskScore INTEGER NOT NULL DEFAULT 0,
      totalCalls INTEGER NOT NULL DEFAULT 0,
      flaggedCalls INTEGER NOT NULL DEFAULT 0,
      maxSeverity INTEGER NOT NULL DEFAULT 0,
      ringbaAffiliateId TEXT,
      notifiedAt TEXT,
      blockedAt TEXT,
      unblockedAt TEXT,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_analysis (
      inboundCallId TEXT PRIMARY KEY,
      publisherName TEXT,
      transcript TEXT,
      transcriptHash TEXT,
      aiScore INTEGER,
      verdict TEXT,
      reasons TEXT,
      analyzedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_call_analysis_hash
      ON call_analysis (transcriptHash);

    CREATE TABLE IF NOT EXISTS fraud_poll_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lastScanAt TEXT,
      lastWindowEnd TEXT
    );

    CREATE TABLE IF NOT EXISTS caller_service_index (
      callerNumber TEXT NOT NULL,
      serviceCategory TEXT NOT NULL,
      publisherName TEXT NOT NULL,
      callCount INTEGER NOT NULL DEFAULT 0,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      PRIMARY KEY (callerNumber, serviceCategory, publisherName)
    );

    CREATE INDEX IF NOT EXISTS idx_caller_service_number
      ON caller_service_index (callerNumber);

    CREATE TABLE IF NOT EXISTS no_connect_index (
      callerNumber TEXT NOT NULL,
      publisherName TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      PRIMARY KEY (callerNumber, publisherName)
    );

    CREATE INDEX IF NOT EXISTS idx_no_connect_number
      ON no_connect_index (callerNumber);
    CREATE INDEX IF NOT EXISTS idx_no_connect_last
      ON no_connect_index (lastSeenAt DESC);

    CREATE TABLE IF NOT EXISTS blocked_numbers (
      callerNumber TEXT PRIMARY KEY,
      blockedAt TEXT NOT NULL,
      ringbaStatus TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS caller_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      callerNumber TEXT NOT NULL,
      publisherName TEXT NOT NULL,
      callDt TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_caller_events_number_dt
      ON caller_events (callerNumber, callDt);
    CREATE INDEX IF NOT EXISTS idx_caller_events_dt
      ON caller_events (callDt);
  `);

  const row = db
    .prepare("SELECT 1 FROM fraud_poll_state WHERE id = 1")
    .get();
  if (!row) {
    db.prepare(
      "INSERT INTO fraud_poll_state (id, lastScanAt, lastWindowEnd) VALUES (1, NULL, NULL)"
    ).run();
  }

  return db;
}

// ---------- poll state ----------

export function getFraudPollState(): {
  lastScanAt: string | null;
  lastWindowEnd: string | null;
} {
  const row = getFraudDb()
    .prepare("SELECT lastScanAt, lastWindowEnd FROM fraud_poll_state WHERE id = 1")
    .get() as { lastScanAt: string | null; lastWindowEnd: string | null };
  return row;
}

export function setFraudPollState(lastScanAt: string, lastWindowEnd: string): void {
  getFraudDb()
    .prepare(
      "UPDATE fraud_poll_state SET lastScanAt = ?, lastWindowEnd = ? WHERE id = 1"
    )
    .run(lastScanAt, lastWindowEnd);
}

// ---------- processed calls (dedup) ----------

export function wasCallProcessed(inboundCallId: string): boolean {
  const row = getFraudDb()
    .prepare("SELECT 1 FROM processed_calls WHERE inboundCallId = ?")
    .get(inboundCallId);
  return row !== undefined;
}

export function markCallProcessed(inboundCallId: string): void {
  getFraudDb()
    .prepare(
      "INSERT OR IGNORE INTO processed_calls (inboundCallId, processedAt) VALUES (?, ?)"
    )
    .run(inboundCallId, new Date().toISOString());
}

// ---------- phone intel cache ----------

export interface PhoneIntelRow {
  phoneNumber: string;
  fetchedAt: string;
  fraudScore: number | null;
  lineType: string | null;
  voip: number | null;
  risky: number | null;
  recentAbuse: number | null;
  spammer: number | null;
  valid: number | null;
  carrier: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  raw: string | null;
}

export function getPhoneIntel(phoneNumber: string): PhoneIntelRow | null {
  const row = getFraudDb()
    .prepare("SELECT * FROM phone_intel WHERE phoneNumber = ?")
    .get(phoneNumber) as PhoneIntelRow | undefined;
  return row ?? null;
}

export function savePhoneIntel(intel: Omit<PhoneIntelRow, "fetchedAt">): void {
  getFraudDb()
    .prepare(
      `INSERT INTO phone_intel (
        phoneNumber, fetchedAt, fraudScore, lineType, voip, risky,
        recentAbuse, spammer, valid, carrier, country, city, region, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phoneNumber) DO UPDATE SET
        fetchedAt = excluded.fetchedAt,
        fraudScore = excluded.fraudScore,
        lineType = excluded.lineType,
        voip = excluded.voip,
        risky = excluded.risky,
        recentAbuse = excluded.recentAbuse,
        spammer = excluded.spammer,
        valid = excluded.valid,
        carrier = excluded.carrier,
        country = excluded.country,
        city = excluded.city,
        region = excluded.region,
        raw = excluded.raw`
    )
    .run(
      intel.phoneNumber,
      new Date().toISOString(),
      intel.fraudScore,
      intel.lineType,
      intel.voip,
      intel.risky,
      intel.recentAbuse,
      intel.spammer,
      intel.valid,
      intel.carrier,
      intel.country,
      intel.city,
      intel.region,
      intel.raw
    );
}

// ---------- caller index (cross-publisher tracking) ----------

export function recordCallerSighting(
  callerNumber: string,
  publisherName: string,
  callDt: string
): void {
  getFraudDb()
    .prepare(
      `INSERT INTO caller_index (callerNumber, publisherName, callCount, firstSeenAt, lastSeenAt)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(callerNumber, publisherName) DO UPDATE SET
         callCount = callCount + 1,
         lastSeenAt = excluded.lastSeenAt`
    )
    .run(callerNumber, publisherName, callDt, callDt);
}

export function publishersForCaller(callerNumber: string): string[] {
  const rows = getFraudDb()
    .prepare(
      "SELECT publisherName FROM caller_index WHERE callerNumber = ? ORDER BY publisherName"
    )
    .all(callerNumber) as Array<{ publisherName: string }>;
  return rows.map((r) => r.publisherName);
}

/**
 * Distinct publishers this caller has appeared under with activity on/after
 * `sinceIso`. The (callerNumber, publisherName) primary key already collapses
 * repeat calls from the same caller under the same publisher into ONE row, so a
 * number hammering a single publisher never counts as multiple publishers.
 * lastSeenAt is the most recent sighting, so the filter answers "seen under
 * this publisher within the window."
 */
export function publishersForCallerSince(
  callerNumber: string,
  sinceIso: string
): string[] {
  const rows = getFraudDb()
    .prepare(
      `SELECT publisherName FROM caller_index
       WHERE callerNumber = ? AND lastSeenAt >= ?
       ORDER BY publisherName`
    )
    .all(callerNumber, sinceIso) as Array<{ publisherName: string }>;
  return rows.map((r) => r.publisherName);
}

// ---------- caller service index (cross-vertical tracking) ----------

/**
 * Per-(caller, service, publisher) sighting counts. This is what powers Seth's
 * rule: shared caller ID split across services with call counts. A caller
 * hammering multiple publishers inside ONE vertical stays one category here;
 * the same number recycled across verticals accumulates distinct categories.
 */
export function recordCallerServiceSighting(
  callerNumber: string,
  serviceCategory: string,
  publisherName: string,
  callDt: string
): void {
  getFraudDb()
    .prepare(
      `INSERT INTO caller_service_index (
         callerNumber, serviceCategory, publisherName, callCount, firstSeenAt, lastSeenAt
       ) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(callerNumber, serviceCategory, publisherName) DO UPDATE SET
         callCount = callCount + 1,
         lastSeenAt = excluded.lastSeenAt`
    )
    .run(callerNumber, serviceCategory, publisherName, callDt, callDt);
}

export interface CallerServiceBreakdownRow {
  serviceCategory: string;
  publisherCount: number;
  callCount: number;
}

/**
 * Distinct service categories a caller has hit since `sinceIso`, with how many
 * publishers and how many calls inside each — e.g. plumbing: 2 pubs / 5 calls,
 * hvac: 1 pub / 2 calls. Category count drives the cross-vertical flag; the
 * per-category values are what the dashboard shows.
 */
export function callerServiceBreakdownSince(
  callerNumber: string,
  sinceIso: string
): CallerServiceBreakdownRow[] {
  return getFraudDb()
    .prepare(
      `SELECT serviceCategory,
              COUNT(DISTINCT publisherName) AS publisherCount,
              SUM(callCount) AS callCount
       FROM caller_service_index
       WHERE callerNumber = ? AND lastSeenAt >= ?
       GROUP BY serviceCategory
       ORDER BY callCount DESC, serviceCategory`
    )
    .all(callerNumber, sinceIso) as CallerServiceBreakdownRow[];
}

// ---------- no-connect tracking (robocalls / solicitors) ----------

export function recordNoConnectSighting(
  callerNumber: string,
  publisherName: string,
  callDt: string
): void {
  getFraudDb()
    .prepare(
      `INSERT INTO no_connect_index (
         callerNumber, publisherName, attempts, firstSeenAt, lastSeenAt
       ) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(callerNumber, publisherName) DO UPDATE SET
         attempts = attempts + 1,
         lastSeenAt = excluded.lastSeenAt`
    )
    .run(callerNumber, publisherName, callDt, callDt);
}

export interface NoConnectNumberRow {
  callerNumber: string;
  attempts: number;
  publisherCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  blockedAt: string | null;
  ringbaStatus: string | null;
}

/** Aggregated no-connect numbers, worst offenders first. */
export function listNoConnectNumbers(limit: number): NoConnectNumberRow[] {
  return getFraudDb()
    .prepare(
      `SELECT n.callerNumber,
              SUM(n.attempts) AS attempts,
              COUNT(DISTINCT n.publisherName) AS publisherCount,
              MIN(n.firstSeenAt) AS firstSeenAt,
              MAX(n.lastSeenAt) AS lastSeenAt,
              b.blockedAt AS blockedAt,
              b.ringbaStatus AS ringbaStatus
       FROM no_connect_index n
       LEFT JOIN blocked_numbers b ON b.callerNumber = n.callerNumber
       GROUP BY n.callerNumber
       ORDER BY (b.blockedAt IS NOT NULL), attempts DESC, lastSeenAt DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 500)) as NoConnectNumberRow[];
}

export function noConnectSummary(): {
  numbersTotal: number;
  numbers24h: number;
  attemptsTotal: number;
  blockedNumbers: number;
} {
  const database = getFraudDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const totals = database
    .prepare(
      `SELECT COUNT(DISTINCT callerNumber) AS numbers,
              COALESCE(SUM(attempts), 0) AS attempts
       FROM no_connect_index`
    )
    .get() as { numbers: number; attempts: number };
  const recent = database
    .prepare(
      "SELECT COUNT(DISTINCT callerNumber) AS c FROM no_connect_index WHERE lastSeenAt >= ?"
    )
    .get(since) as { c: number };
  const blocked = database
    .prepare("SELECT COUNT(*) AS c FROM blocked_numbers")
    .get() as { c: number };
  return {
    numbersTotal: totals.numbers,
    numbers24h: recent.c,
    attemptsTotal: totals.attempts,
    blockedNumbers: blocked.c,
  };
}

export function markNumberBlocked(
  callerNumber: string,
  ringbaStatus: string,
  note: string | null
): void {
  getFraudDb()
    .prepare(
      `INSERT INTO blocked_numbers (callerNumber, blockedAt, ringbaStatus, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(callerNumber) DO UPDATE SET
         blockedAt = excluded.blockedAt,
         ringbaStatus = excluded.ringbaStatus,
         note = excluded.note`
    )
    .run(callerNumber, new Date().toISOString(), ringbaStatus, note);
}

export function markNumberUnblocked(callerNumber: string): void {
  getFraudDb()
    .prepare("DELETE FROM blocked_numbers WHERE callerNumber = ?")
    .run(callerNumber);
}

/**
 * Housekeeping: drop no-connect pairs stale for `days` (blocked numbers are
 * kept forever). Robocallers rotate numbers, so without this the index grows
 * without bound.
 */
export function pruneNoConnectIndex(days = 90): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = getFraudDb()
    .prepare(
      `DELETE FROM no_connect_index
       WHERE lastSeenAt < ?
         AND callerNumber NOT IN (SELECT callerNumber FROM blocked_numbers)`
    )
    .run(cutoff);
  return result.changes;
}

// ---------- caller events (time + geo clustering) ----------

/**
 * One row per call sighting (connected AND no-connect), retained ~7 days.
 * Powers the coordinated-attack window check (same caller, N publishers,
 * minutes apart) and 24h geographic clustering via a join to phone_intel.
 */
export function recordCallerEvent(
  callerNumber: string,
  publisherName: string,
  callDt: string,
  connected: boolean
): void {
  getFraudDb()
    .prepare(
      `INSERT INTO caller_events (callerNumber, publisherName, callDt, connected)
       VALUES (?, ?, ?, ?)`
    )
    .run(callerNumber, publisherName, callDt, connected ? 1 : 0);
}

/** Distinct publishers this caller hit inside [startIso, endIso], any duration. */
export function publishersForCallerBetween(
  callerNumber: string,
  startIso: string,
  endIso: string
): string[] {
  const rows = getFraudDb()
    .prepare(
      `SELECT DISTINCT publisherName FROM caller_events
       WHERE callerNumber = ? AND callDt >= ? AND callDt <= ?
       ORDER BY publisherName`
    )
    .all(callerNumber, startIso, endIso) as Array<{ publisherName: string }>;
  return rows.map((r) => r.publisherName);
}

/**
 * Distinct publishers this caller hit since `sinceIso`, counting connected AND
 * no-connect events — the robocall-cap input (a number spraying 9+ publishers
 * is a robocaller, whatever the durations were).
 */
export function distinctPublisherCountForCallerSince(
  callerNumber: string,
  sinceIso: string
): number {
  const row = getFraudDb()
    .prepare(
      `SELECT COUNT(DISTINCT publisherName) AS c FROM caller_events
       WHERE callerNumber = ? AND callDt >= ?`
    )
    .get(callerNumber, sinceIso) as { c: number };
  return row.c;
}

/** Events older than `days` are dropped — window checks never look back further. */
export function pruneCallerEvents(days = 7): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = getFraudDb()
    .prepare("DELETE FROM caller_events WHERE callDt < ?")
    .run(cutoff);
  return result.changes;
}

export interface GeoClusterRow {
  city: string;
  region: string;
  callCount: number;
  numberCount: number;
  publisherCount: number;
  sampleNumbers: string;
}

/**
 * Cities producing `minCalls`+ calls since `sinceIso`, via caller_events joined
 * to cached IPQS geo data. Only numbers that have been IPQS-looked-up carry a
 * city, so clusters reflect scanned traffic.
 */
export function listGeoClusters(sinceIso: string, minCalls: number): GeoClusterRow[] {
  return getFraudDb()
    .prepare(
      `SELECT p.city AS city,
              COALESCE(p.region, '') AS region,
              COUNT(*) AS callCount,
              COUNT(DISTINCT e.callerNumber) AS numberCount,
              COUNT(DISTINCT e.publisherName) AS publisherCount,
              GROUP_CONCAT(DISTINCT e.callerNumber) AS sampleNumbers
       FROM caller_events e
       JOIN phone_intel p ON p.phoneNumber = e.callerNumber
       WHERE e.callDt >= ?
         AND p.city IS NOT NULL AND p.city != '' AND LOWER(p.city) != 'n/a'
       GROUP BY LOWER(p.city), LOWER(COALESCE(p.region, ''))
       HAVING COUNT(*) >= ?
       ORDER BY callCount DESC
       LIMIT 50`
    )
    .all(sinceIso, Math.max(1, minCalls)) as GeoClusterRow[];
}

// ---------- flagged calls ----------

export interface FlagCallInput {
  inboundCallId: string;
  publisherName: string;
  callerNumber: string | null;
  callDt: string | null;
  reason:
    | "voip"
    | "shared_caller"
    | "cross_vertical"
    | "coordinated_attack"
    | "ai_analysis";
  severity: number;
  detail: Record<string, unknown>;
}

/** Insert a flag; returns true when it is new (not previously flagged for that reason). */
export function flagCall(input: FlagCallInput): boolean {
  const result = getFraudDb()
    .prepare(
      `INSERT OR IGNORE INTO flagged_calls (
        inboundCallId, publisherName, callerNumber, callDt,
        reason, severity, detail, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.inboundCallId,
      input.publisherName,
      input.callerNumber,
      input.callDt,
      input.reason,
      Math.max(0, Math.min(100, Math.round(input.severity))),
      JSON.stringify(input.detail),
      new Date().toISOString()
    );
  return result.changes > 0;
}

export interface FlaggedCallRow {
  id: number;
  inboundCallId: string;
  publisherName: string;
  callerNumber: string | null;
  callDt: string | null;
  reason: string;
  severity: number;
  detail: string | null;
  createdAt: string;
}

export function listFlaggedCalls(limit: number): FlaggedCallRow[] {
  return getFraudDb()
    .prepare(
      `SELECT id, inboundCallId, publisherName, callerNumber, callDt,
              reason, severity, detail, createdAt
       FROM flagged_calls
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 500)) as FlaggedCallRow[];
}

/** Every flag for one publisher, worst first — backs the risk-score breakdown. */
export function listFlaggedCallsForPublisher(
  publisherName: string,
  limit: number
): FlaggedCallRow[] {
  return getFraudDb()
    .prepare(
      `SELECT id, inboundCallId, publisherName, callerNumber, callDt,
              reason, severity, detail, createdAt
       FROM flagged_calls
       WHERE publisherName = ?
       ORDER BY severity DESC, id DESC
       LIMIT ?`
    )
    .all(publisherName, Math.min(Math.max(limit, 1), 500)) as FlaggedCallRow[];
}

export function flaggedCallsForCall(inboundCallId: string): FlaggedCallRow[] {
  return getFraudDb()
    .prepare(
      `SELECT id, inboundCallId, publisherName, callerNumber, callDt,
              reason, severity, detail, createdAt
       FROM flagged_calls WHERE inboundCallId = ? ORDER BY id`
    )
    .all(inboundCallId) as FlaggedCallRow[];
}

export function countFlaggedCallsSince(sinceIso: string): number {
  const row = getFraudDb()
    .prepare(
      "SELECT COUNT(DISTINCT inboundCallId) AS c FROM flagged_calls WHERE createdAt >= ?"
    )
    .get(sinceIso) as { c: number };
  return row.c;
}

// ---------- publisher fraud status ----------

export interface PublisherFraudRow {
  publisherName: string;
  status: "clear" | "suspicious" | "blocked";
  riskScore: number;
  totalCalls: number;
  flaggedCalls: number;
  maxSeverity: number;
  ringbaAffiliateId: string | null;
  notifiedAt: string | null;
  blockedAt: string | null;
  unblockedAt: string | null;
  updatedAt: string;
}

export function getPublisherFraud(publisherName: string): PublisherFraudRow | null {
  const row = getFraudDb()
    .prepare("SELECT * FROM publisher_fraud WHERE publisherName = ?")
    .get(publisherName) as PublisherFraudRow | undefined;
  return row ?? null;
}

/**
 * Publishers worth showing on the war-room table: only those actually flagged
 * or blocked. Clear publishers with zero flags are noise — they used to fill
 * the bottom of the table and made "flagged" indistinguishable from "scanned."
 */
export function listPublisherFraud(): PublisherFraudRow[] {
  return getFraudDb()
    .prepare(
      `SELECT * FROM publisher_fraud
       WHERE status = 'blocked' OR flaggedCalls > 0
       ORDER BY (status = 'blocked') DESC, riskScore DESC, publisherName`
    )
    .all() as PublisherFraudRow[];
}

function ensurePublisherRow(publisherName: string): void {
  getFraudDb()
    .prepare(
      `INSERT OR IGNORE INTO publisher_fraud (publisherName, status, updatedAt)
       VALUES (?, 'clear', ?)`
    )
    .run(publisherName, new Date().toISOString());
}

export function bumpPublisherTotals(
  publisherName: string,
  processedCalls: number
): void {
  ensurePublisherRow(publisherName);
  getFraudDb()
    .prepare(
      `UPDATE publisher_fraud
       SET totalCalls = totalCalls + ?, updatedAt = ?
       WHERE publisherName = ?`
    )
    .run(processedCalls, new Date().toISOString(), publisherName);
}

/**
 * Recompute a publisher's flag aggregates + risk score from flagged_calls.
 * Risk score: 60% weight on flag rate, 40% on worst severity seen.
 * A blocked publisher stays blocked; otherwise flags mean 'suspicious'.
 */
export function recomputePublisherRisk(publisherName: string): PublisherFraudRow {
  ensurePublisherRow(publisherName);
  const database = getFraudDb();

  const agg = database
    .prepare(
      `SELECT COUNT(DISTINCT inboundCallId) AS flagged, COALESCE(MAX(severity), 0) AS maxSev
       FROM flagged_calls WHERE publisherName = ?`
    )
    .get(publisherName) as { flagged: number; maxSev: number };

  const existing = getPublisherFraud(publisherName)!;
  const total = Math.max(existing.totalCalls, agg.flagged, 1);
  const flagRate = agg.flagged / total;
  const riskScore = Math.min(
    100,
    Math.round(60 * Math.min(flagRate * 2, 1) + 0.4 * agg.maxSev)
  );
  const status =
    existing.status === "blocked"
      ? "blocked"
      : agg.flagged > 0
        ? "suspicious"
        : "clear";

  database
    .prepare(
      `UPDATE publisher_fraud
       SET flaggedCalls = ?, maxSeverity = ?, riskScore = ?, status = ?, updatedAt = ?
       WHERE publisherName = ?`
    )
    .run(
      agg.flagged,
      agg.maxSev,
      riskScore,
      status,
      new Date().toISOString(),
      publisherName
    );

  return getPublisherFraud(publisherName)!;
}

/**
 * One-shot cleanup for the old low-threshold shared-caller rule: delete any
 * shared_caller flag whose recorded publisherCount is below `minPublishers`
 * (default 3), then recompute risk for every publisher that lost a flag.
 * Idempotent — after the first pass nothing matches. Returns how many flags
 * were removed so callers can log it. Only touches shared_caller flags; VOIP
 * and AI flags are never affected.
 */
export function pruneStaleSharedCallerFlags(minPublishers = 3): number {
  const database = getFraudDb();

  const affected = database
    .prepare(
      `SELECT DISTINCT publisherName FROM flagged_calls
       WHERE reason = 'shared_caller'
         AND COALESCE(CAST(json_extract(detail, '$.publisherCount') AS INTEGER), 0) < ?`
    )
    .all(minPublishers) as Array<{ publisherName: string }>;

  if (affected.length === 0) {
    return 0;
  }

  const del = database
    .prepare(
      `DELETE FROM flagged_calls
       WHERE reason = 'shared_caller'
         AND COALESCE(CAST(json_extract(detail, '$.publisherCount') AS INTEGER), 0) < ?`
    )
    .run(minPublishers);

  for (const { publisherName } of affected) {
    recomputePublisherRisk(publisherName);
  }

  return del.changes;
}

/**
 * Retroactive side of the robocall cap (Seth): shared-caller flags whose
 * recorded publisherCount exceeds `maxPublishers` were robocallers, not fraud
 * rings — delete them and recompute risk for every publisher that lost one.
 * Idempotent; never touches VOIP, AI, cross-vertical, or coordinated flags.
 */
export function pruneOverBroadSharedCallerFlags(maxPublishers: number): number {
  const database = getFraudDb();

  const affected = database
    .prepare(
      `SELECT DISTINCT publisherName FROM flagged_calls
       WHERE reason = 'shared_caller'
         AND COALESCE(CAST(json_extract(detail, '$.publisherCount') AS INTEGER), 0) > ?`
    )
    .all(maxPublishers) as Array<{ publisherName: string }>;

  if (affected.length === 0) {
    return 0;
  }

  const del = database
    .prepare(
      `DELETE FROM flagged_calls
       WHERE reason = 'shared_caller'
         AND COALESCE(CAST(json_extract(detail, '$.publisherCount') AS INTEGER), 0) > ?`
    )
    .run(maxPublishers);

  for (const { publisherName } of affected) {
    recomputePublisherRisk(publisherName);
  }

  return del.changes;
}

export function setPublisherNotifiedAt(publisherName: string, at: string): void {
  ensurePublisherRow(publisherName);
  getFraudDb()
    .prepare(
      "UPDATE publisher_fraud SET notifiedAt = ?, updatedAt = ? WHERE publisherName = ?"
    )
    .run(at, new Date().toISOString(), publisherName);
}

export function setPublisherRingbaAffiliateId(
  publisherName: string,
  affiliateId: string
): void {
  ensurePublisherRow(publisherName);
  getFraudDb()
    .prepare(
      "UPDATE publisher_fraud SET ringbaAffiliateId = ?, updatedAt = ? WHERE publisherName = ?"
    )
    .run(affiliateId, new Date().toISOString(), publisherName);
}

export function setPublisherBlocked(
  publisherName: string,
  blocked: boolean
): PublisherFraudRow {
  ensurePublisherRow(publisherName);
  const now = new Date().toISOString();
  if (blocked) {
    getFraudDb()
      .prepare(
        `UPDATE publisher_fraud
         SET status = 'blocked', blockedAt = ?, updatedAt = ?
         WHERE publisherName = ?`
      )
      .run(now, now, publisherName);
  } else {
    getFraudDb()
      .prepare(
        `UPDATE publisher_fraud
         SET status = CASE WHEN flaggedCalls > 0 THEN 'suspicious' ELSE 'clear' END,
             unblockedAt = ?, updatedAt = ?
         WHERE publisherName = ?`
      )
      .run(now, now, publisherName);
  }
  return getPublisherFraud(publisherName)!;
}

// ---------- call analysis (step 3) ----------

export interface CallAnalysisRow {
  inboundCallId: string;
  publisherName: string | null;
  transcript: string | null;
  transcriptHash: string | null;
  aiScore: number | null;
  verdict: string | null;
  reasons: string | null;
  analyzedAt: string;
}

export function getCallAnalysis(inboundCallId: string): CallAnalysisRow | null {
  const row = getFraudDb()
    .prepare("SELECT * FROM call_analysis WHERE inboundCallId = ?")
    .get(inboundCallId) as CallAnalysisRow | undefined;
  return row ?? null;
}

export function saveCallAnalysis(row: Omit<CallAnalysisRow, "analyzedAt">): void {
  getFraudDb()
    .prepare(
      `INSERT INTO call_analysis (
        inboundCallId, publisherName, transcript, transcriptHash,
        aiScore, verdict, reasons, analyzedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inboundCallId) DO UPDATE SET
        publisherName = excluded.publisherName,
        transcript = excluded.transcript,
        transcriptHash = excluded.transcriptHash,
        aiScore = excluded.aiScore,
        verdict = excluded.verdict,
        reasons = excluded.reasons,
        analyzedAt = excluded.analyzedAt`
    )
    .run(
      row.inboundCallId,
      row.publisherName,
      row.transcript,
      row.transcriptHash,
      row.aiScore,
      row.verdict,
      row.reasons,
      new Date().toISOString()
    );
}

/** Count how many analyzed calls share this normalized transcript hash. */
export function transcriptHashCount(transcriptHash: string): number {
  const row = getFraudDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM call_analysis WHERE transcriptHash = ? AND transcriptHash IS NOT NULL"
    )
    .get(transcriptHash) as { c: number };
  return row.c;
}

// ---------- IPQS pipeline audit ----------

/**
 * Launch-to-date IPQS usage stats, computed from fraud.db. One paid lookup =
 * one phone_intel row (repeat sightings serve from cache), so this is the
 * ground truth for what the IPQS subscription is actually doing.
 */
export function ipqsAudit(): Record<string, unknown> {
  const db = getFraudDb();

  const intel = db
    .prepare(
      `SELECT COUNT(*) AS numbersLookedUp,
              SUM(CASE WHEN voip = 1 THEN 1 ELSE 0 END) AS voipNumbers,
              SUM(CASE WHEN fraudScore >= 85 THEN 1 ELSE 0 END) AS fraudScore85Plus,
              SUM(CASE WHEN recentAbuse = 1 OR spammer = 1 THEN 1 ELSE 0 END) AS abuseOrSpammer,
              SUM(CASE WHEN city IS NOT NULL AND city != '' AND LOWER(city) != 'n/a' THEN 1 ELSE 0 END) AS withCity,
              SUM(CASE WHEN region IS NOT NULL AND region != '' AND LOWER(region) != 'n/a' THEN 1 ELSE 0 END) AS withRegion,
              SUM(CASE WHEN fetchedAt < datetime('now', '-30 days') THEN 1 ELSE 0 END) AS cacheExpired,
              MIN(fetchedAt) AS firstLookupAt,
              MAX(fetchedAt) AS lastLookupAt
       FROM phone_intel`
    )
    .get() as Record<string, unknown>;

  const processed = db
    .prepare("SELECT COUNT(*) AS c FROM processed_calls")
    .get() as { c: number };

  const callers = db
    .prepare(
      `SELECT COUNT(DISTINCT callerNumber) AS uniqueCallers,
              COALESCE(SUM(callCount), 0) AS totalSightings
       FROM caller_index`
    )
    .get() as { uniqueCallers: number; totalSightings: number };

  const voipFlags = db
    .prepare(
      `SELECT COUNT(*) AS flags,
              COUNT(DISTINCT inboundCallId) AS calls,
              COUNT(DISTINCT callerNumber) AS numbers
       FROM flagged_calls WHERE reason = 'voip'`
    )
    .get() as Record<string, unknown>;

  const lineTypes = db
    .prepare(
      `SELECT COALESCE(lineType, 'unknown') AS lineType, COUNT(*) AS count
       FROM phone_intel GROUP BY COALESCE(lineType, 'unknown')
       ORDER BY count DESC LIMIT 8`
    )
    .all();

  const topCarriers = db
    .prepare(
      `SELECT COALESCE(carrier, 'unknown') AS carrier, COUNT(*) AS count
       FROM phone_intel GROUP BY COALESCE(carrier, 'unknown')
       ORDER BY count DESC LIMIT 10`
    )
    .all();

  const numbersLookedUp = Number(intel.numbersLookedUp ?? 0);
  return {
    generatedAt: new Date().toISOString(),
    callsProcessedTotal: processed.c,
    uniqueCallersSeen: callers.uniqueCallers,
    totalCallSightings: callers.totalSightings,
    paidLookups: numbersLookedUp,
    // Repeat sightings of an already-looked-up number are cache hits.
    estimatedLookupsSavedByCache: Math.max(
      0,
      callers.totalSightings - callers.uniqueCallers
    ),
    cacheEntriesOlderThan30d: Number(intel.cacheExpired ?? 0),
    firstLookupAt: intel.firstLookupAt ?? null,
    lastLookupAt: intel.lastLookupAt ?? null,
    voip: {
      numbersFlaggedVoip: Number(intel.voipNumbers ?? 0),
      voipFlagRows: voipFlags,
    },
    fraudScore85PlusNumbers: Number(intel.fraudScore85Plus ?? 0),
    abuseOrSpammerNumbers: Number(intel.abuseOrSpammer ?? 0),
    geo: {
      withCity: Number(intel.withCity ?? 0),
      withRegion: Number(intel.withRegion ?? 0),
      cityCoveragePct: numbersLookedUp
        ? Math.round((Number(intel.withCity ?? 0) / numbersLookedUp) * 100)
        : 0,
    },
    lineTypes,
    topCarriers,
  };
}

// ---------- dashboard summary ----------

export function fraudSummary(): {
  flaggedCalls24h: number;
  flaggedCallsTotal: number;
  suspiciousPublishers: number;
  blockedPublishers: number;
  lastScanAt: string | null;
} {
  const database = getFraudDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const total = database
    .prepare("SELECT COUNT(DISTINCT inboundCallId) AS c FROM flagged_calls")
    .get() as { c: number };
  const statuses = database
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM publisher_fraud`
    )
    .get() as { suspicious: number | null; blocked: number | null };
  const state = getFraudPollState();

  return {
    flaggedCalls24h: countFlaggedCallsSince(since),
    flaggedCallsTotal: total.c,
    suspiciousPublishers: statuses.suspicious ?? 0,
    blockedPublishers: statuses.blocked ?? 0,
    lastScanAt: state.lastScanAt,
  };
}

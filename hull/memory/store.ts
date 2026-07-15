import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

function resolveHullDbPath(): string {
  if (existsSync("/data")) return "/data/aethon-memory.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "aethon-memory.db");
}

let db: Database.Database | null = null;

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      keywords TEXT DEFAULT '',
      strength REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      last_accessed TEXT,
      created_at TEXT NOT NULL,
      superseded_by TEXT,
      embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      summary TEXT,
      tone TEXT,
      decisions TEXT,
      entities TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'unknown',
      properties TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      last_reinforced TEXT
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      confidence REAL DEFAULT 0.8,
      use_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_reinforced TEXT
    );

    CREATE TABLE IF NOT EXISTS syntheses (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      week_start TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity_dimensions (
      dimension TEXT PRIMARY KEY,
      confidence REAL DEFAULT 0.0,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS identity_questions (
      id TEXT PRIMARY KEY,
      dimension TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      answered INTEGER DEFAULT 0,
      answer_fact_id TEXT
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT,
      chars INTEGER NOT NULL DEFAULT 0,
      chunkCount INTEGER NOT NULL DEFAULT 0,
      chunksDone INTEGER NOT NULL DEFAULT 0,
      factsExtracted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      createdAt TEXT NOT NULL,
      completedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_session
      ON conversations(session_id, id);

    CREATE INDEX IF NOT EXISTS idx_facts_strength ON facts(strength DESC);
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_rules_confidence ON rules(confidence DESC);
  `);
}

/** Additive column migrations for databases created before these fields existed. */
function migrateFactColumns(database: Database.Database): void {
  const columns = database
    .prepare("PRAGMA table_info(facts)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("importance")) {
    database.exec("ALTER TABLE facts ADD COLUMN importance INTEGER DEFAULT 5");
  }
  if (!names.has("source_document")) {
    database.exec("ALTER TABLE facts ADD COLUMN source_document TEXT");
  }
}

export function getHullDb(): Database.Database {
  if (db) return db;
  const dbPath = resolveHullDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  migrateFactColumns(db);
  return db;
}

export function getSystemState(key: string): string | null {
  const row = getHullDb()
    .prepare("SELECT value FROM system_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSystemState(key: string, value: string): void {
  getHullDb()
    .prepare("INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { closeDbConnection } from "./logger";
import { getDataDir, getDbPath } from "./paths";

const SQLITE_MAGIC = "SQLite format 3\u0000";

function isSqliteFile(buffer: Buffer): boolean {
  if (buffer.length < 16) {
    return false;
  }
  return buffer.subarray(0, 16).toString("utf8") === SQLITE_MAGIC;
}

function validateDatabaseFile(dbPath: string): { scrubRows: number } {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS c FROM scrub_log")
      .get() as { c: number };
    return { scrubRows: row.c };
  } finally {
    database.close();
  }
}

/**
 * Replaces scrub_log.db on disk with the uploaded bytes.
 */
export function importDatabaseFile(buffer: Buffer): {
  path: string;
  scrubRows: number;
  bytes: number;
} {
  if (!isSqliteFile(buffer)) {
    throw new Error("Upload is not a valid SQLite database file");
  }

  const dataDir = getDataDir();
  const dbPath = getDbPath();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  closeDbConnection();

  const tmpPath = path.join(dataDir, `scrub_log.import-${Date.now()}.db`);
  fs.writeFileSync(tmpPath, buffer);

  const stats = validateDatabaseFile(tmpPath);

  const backupPath = path.join(dataDir, "scrub_log.backup.db");
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath);
  }

  fs.renameSync(tmpPath, dbPath);

  return {
    path: dbPath,
    scrubRows: stats.scrubRows,
    bytes: buffer.length,
  };
}

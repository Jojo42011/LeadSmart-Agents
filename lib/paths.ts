import * as path from "path";

/** Fly volume mount path (see fly.toml [mounts]). */
export const PRODUCTION_DATA_DIR = "/app/data";

/**
 * Project root (RINGBA/). Works for ts-node and dist/*.js.
 */
export function getAppRoot(): string {
  const dir = __dirname;
  const base = path.basename(dir);

  if (base === "dist") {
    return path.join(dir, "..");
  }
  if (base === "lib") {
    const parent = path.join(dir, "..");
    if (path.basename(parent) === "dist") {
      return path.join(parent, "..");
    }
    return parent;
  }
  return dir;
}

/**
 * SQLite data directory.
 * Production/Fly: /app/data (or DATA_DIR env).
 * Local dev: ./data under project root.
 */
export function getDataDir(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_DATA_DIR;
  }
  return path.join(getAppRoot(), "data");
}

export function getDbPath(): string {
  return path.join(getDataDir(), "scrub_log.db");
}

export function getPublicDir(): string {
  return path.join(getAppRoot(), "public");
}

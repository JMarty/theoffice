import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { log } from "../logger.js";

const logger = log("db");

export type DB = Database.Database;

let handle: DB | undefined;

/**
 * Open (and cache) the SQLite database at `dbFile`. Creates the file with 0600
 * perms before opening (no world-readable window), enables WAL + sane pragmas,
 * and applies the schema idempotently.
 */
export function openDb(dbFile: string): DB {
  if (handle) return handle;

  mkdirSync(dirname(dbFile), { recursive: true });
  if (!existsSync(dbFile)) {
    // pre-create at 0600 to avoid a world-readable TOCTOU window
    closeSync(openSync(dbFile, "a", 0o600));
  }

  const db = new Database(dbFile);
  try {
    chmodSync(dbFile, 0o600);
  } catch {
    /* best-effort */
  }

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA_SQL);

  logger.info({ dbFile }, "database ready (WAL)");
  handle = db;
  return db;
}

export function getDb(): DB {
  if (!handle) throw new Error("db not opened — call openDb() first");
  return handle;
}

export function closeDb(): void {
  if (handle) {
    try {
      handle.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    handle.close();
    handle = undefined;
  }
}

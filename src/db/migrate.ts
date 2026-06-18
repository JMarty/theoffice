import type Database from "better-sqlite3";
import { log } from "../logger.js";

const logger = log("db");

export interface Migration {
  /** strictly increasing version; the next migration is `lastVersion + 1` */
  version: number;
  /** SQL applied in a single transaction at this version (ALTER, backfill, new index, ...) */
  sql: string;
}

/**
 * Ordered, forward-only schema migrations applied via PRAGMA user_version.
 *
 * The base schema (schema.ts) uses CREATE TABLE IF NOT EXISTS — that builds the CURRENT schema for FRESH
 * installs, but can't evolve an EXISTING tenant DB. Any change to existing tables (a new column, a backfill)
 * must be added here as the next version. Because the ⟳ Update button is first-class, without this the first
 * such change would crash-loop the engine on a live DB ("no such column"). Each migration runs once, in a
 * transaction, oldest-first. (Empty today — the scaffold exists so the first schema change is safe.)
 */
export const MIGRATIONS: Migration[] = [
  // { version: 1, sql: `ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0` },
];

function latestVersion(migrations: Migration[]): number {
  return migrations.reduce((mx, m) => Math.max(mx, m.version), 0);
}

/**
 * Bring a DB's schema up to date.
 *  - FRESH install: schema.ts already created the current schema, so just stamp user_version = latest
 *    (skip every migration — they're already reflected in the base schema).
 *  - EXISTING DB at version V: run each migration with version > V, in order, bumping user_version per step.
 */
export function runMigrations(db: Database.Database, fresh: boolean, migrations: Migration[] = MIGRATIONS): void {
  const latest = latestVersion(migrations);
  if (fresh) {
    if (latest > 0) db.pragma(`user_version = ${latest}`);
    return;
  }
  const current = Number(db.pragma("user_version", { simple: true })) || 0;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    logger.info({ version: m.version }, "applied db migration");
  }
}

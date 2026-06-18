import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "./migrate.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE t (id INTEGER)`);
});
afterEach(() => db.close());

const uv = () => Number(db.pragma("user_version", { simple: true }));
const cols = () => (db.prepare(`PRAGMA table_info(t)`).all() as { name: string }[]).map((c) => c.name);

const MIGS: Migration[] = [
  { version: 1, sql: `ALTER TABLE t ADD COLUMN a INTEGER` },
  { version: 2, sql: `ALTER TABLE t ADD COLUMN b INTEGER` },
];

describe("runMigrations", () => {
  it("fresh install stamps user_version = latest and runs no migration SQL", () => {
    runMigrations(db, true, MIGS);
    expect(uv()).toBe(2);
    expect(cols()).toEqual(["id"]); // schema assumed already current; migrations skipped
  });

  it("existing DB runs all pending migrations in order, bumping user_version", () => {
    runMigrations(db, false, MIGS);
    expect(uv()).toBe(2);
    expect(cols()).toEqual(["id", "a", "b"]);
  });

  it("only applies migrations newer than the current version (idempotent re-run)", () => {
    runMigrations(db, false, [MIGS[0]!]);
    expect(cols()).toEqual(["id", "a"]);
    // a second run with the SAME migration must be a no-op (else 'duplicate column' would throw)
    expect(() => runMigrations(db, false, [MIGS[0]!])).not.toThrow();
    expect(uv()).toBe(1);
  });

  it("an empty migration list is a no-op for both fresh and existing", () => {
    runMigrations(db, false, []);
    expect(uv()).toBe(0);
    runMigrations(db, true, []);
    expect(uv()).toBe(0);
  });
});

/**
 * One-shot importer: old `claudeclaw.db` (v1) -> marveen-v2 store.
 *
 * Safety contract (from ):
 *  - NEVER read the live WAL file directly. We first take a consistent hot
 *    snapshot via `sqlite3 .backup`, run PRAGMA integrity_check on it, then
 *    import from the SNAPSHOT (opened read-only). The live crown-jewel DB is
 *    only ever read by the backup, never written by us.
 *  - Idempotent: target tables are cleared inside one transaction, then loaded.
 *  - Verifies row counts (snapshot vs target) per table and fails loudly on drift.
 *
 * Usage:
 *   tsx src/migrate-import/import-claudeclaw.ts --source /path/claudeclaw.db [--keep-snapshot]
 *   (defaults source to /opt/claude/marveen/marveen/store/claudeclaw.db)
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { openDb, closeDb } from "../db/index.js";
import { log } from "../logger.js";

const logger = log("import");

interface TableCopy {
  table: string;
  /** columns to SELECT from the snapshot (source order) */
  src: string[];
  /** columns to INSERT into v2 (must align 1:1 with src) */
  dst: string[];
}

// Explicit column mappings (source v1 -> target v2). Order matters: src[i] -> dst[i].
const TABLES: TableCopy[] = [
  {
    table: "memories",
    src: ["id", "agent_id", "category", "content", "keywords", "sector", "salience", "embedding", "auto_generated", "created_at", "accessed_at"],
    dst: ["id", "agent_id", "category", "content", "keywords", "sector", "salience", "embedding", "auto_generated", "created_at", "accessed_at"],
  },
  {
    table: "kanban_cards",
    src: ["id", "title", "description", "status", "assignee", "priority", "project", "parent_id", "due_date", "sort_order", "created_at", "updated_at", "archived_at", "dispatched_at"],
    dst: ["id", "title", "description", "status", "assignee", "priority", "project", "parent_id", "due_date", "sort_order", "created_at", "updated_at", "archived_at", "dispatched_at"],
  },
  {
    table: "kanban_comments",
    src: ["id", "card_id", "author", "content", "created_at"],
    dst: ["id", "card_id", "author", "content", "created_at"],
  },
  {
    table: "agent_messages",
    src: ["id", "from_agent", "to_agent", "content", "status", "result", "created_at", "delivered_at", "completed_at"],
    dst: ["id", "from_agent", "to_agent", "content", "status", "result", "created_at", "delivered_at", "completed_at"],
  },
  {
    table: "daily_logs",
    src: ["id", "agent_id", "date", "content", "created_at"],
    dst: ["id", "agent_id", "date", "content", "created_at"],
  },
  {
    table: "conversation_log",
    src: ["id", "agent_id", "chat_id", "direction", "message_id", "text", "ts", "created_at"],
    dst: ["id", "agent_id", "channel_id", "direction", "message_id", "text", "ts", "created_at"],
  },
  {
    table: "token_usage",
    src: ["id", "agent", "session_id", "timestamp", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "content_preview", "tool_name", "task_title", "project"],
    dst: ["id", "agent", "session_id", "timestamp", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "content_preview", "tool_name", "task_title", "project"],
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function snapshot(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mv2-import-"));
  const snap = join(dir, "snapshot.db");
  logger.info({ source, snap }, "taking hot snapshot (sqlite3 .backup)");
  execFileSync("sqlite3", [source, `.backup '${snap}'`], { stdio: "pipe" });
  const check = execFileSync("sqlite3", [snap, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  if (check !== "ok") throw new Error(`snapshot integrity_check failed: ${check}`);
  logger.info("snapshot integrity_check ok");
  return snap;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function main(): void {
  const source = arg("--source") ?? "/opt/claude/marveen/marveen/store/claudeclaw.db";
  if (!existsSync(source)) throw new Error(`source DB not found: ${source}`);

  const cfg = loadConfig();
  const snap = snapshot(source);
  const snapDir = join(snap, "..");

  const old = new Database(snap, { readonly: true, fileMustExist: true });
  const db = openDb(cfg.paths.dbFile);

  const report: Array<{ table: string; src: number; dst: number; ok: boolean }> = [];

  const run = db.transaction(() => {
    for (const t of TABLES) {
      if (!tableExists(old, t.table)) {
        logger.warn({ table: t.table }, "source table missing, skipping");
        report.push({ table: t.table, src: 0, dst: 0, ok: true });
        continue;
      }
      db.prepare(`DELETE FROM ${t.table}`).run();
      const rows = old.prepare(`SELECT ${t.src.join(", ")} FROM ${t.table}`).all() as Record<string, unknown>[];
      const placeholders = t.dst.map(() => "?").join(", ");
      const ins = db.prepare(`INSERT INTO ${t.table} (${t.dst.join(", ")}) VALUES (${placeholders})`);
      for (const r of rows) {
        ins.run(...t.src.map((c) => r[c] as unknown));
      }
      const dstCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get() as { n: number }).n;
      report.push({ table: t.table, src: rows.length, dst: dstCount, ok: rows.length === dstCount });
    }
  });
  run();

  // verify FTS rebuilt for memories
  let ftsCount = 0;
  try {
    ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get() as { n: number }).n;
  } catch {
    /* ignore */
  }

  old.close();
  closeDb();
  if (!flag("--keep-snapshot")) rmSync(snapDir, { recursive: true, force: true });

  // ---- report ----
  console.log("\n=== claudeclaw -> marveen-v2 import report ===");
  let allOk = true;
  for (const r of report) {
    const mark = r.ok ? "OK " : "!! ";
    if (!r.ok) allOk = false;
    console.log(`  ${mark} ${r.table.padEnd(18)} src=${String(r.src).padStart(5)}  dst=${String(r.dst).padStart(5)}`);
  }
  console.log(`  --  memories_fts entries: ${ftsCount}`);
  console.log(allOk ? "\nALL TABLES MATCH ✓" : "\nROW-COUNT MISMATCH — investigate before trusting the import");
  if (!allOk) process.exit(2);
}

main();

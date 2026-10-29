import type { Database as DB } from "better-sqlite3";

/**
 * Task completion: a fired scheduled task is only a promise until the agent says it is finished. The prompt carries
 * a run id and one instruction (POST /api/task-runs/:id/complete); a sweep alarms the main agent about task runs
 * still open after N minutes. Heartbeats are silent checks: they may complete, but are never alarmed.
 */
export const OUTCOMES = ["done", "nothing_to_report", "failed", "skipped"] as const;
export type Outcome = (typeof OUTCOMES)[number];
const NOTE_MAX = 200;

export function expectsCompletion(type: "task" | "heartbeat"): 0 | 1 {
  return type === "task" ? 1 : 0;
}

export function completionInstruction(runId: number): string {
  return (
    `\n\n[Run #${runId}] When you have finished this run, record it (one call, nothing else to say):\n` +
    `curl -s -X POST "http://127.0.0.1:\${OFFICE_PORT:-3430}/api/task-runs/${runId}/complete" ` +
    `-H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" -H "Content-Type: application/json" ` +
    `-d '{"outcome":"done","note":"<one short line>"}'   # outcome: ${OUTCOMES.join(" | ")}`
  );
}

export type CompleteResult = "ok" | "already" | "missing" | "bad_outcome";

/** Close a run. Idempotent: the first completion wins, a repeat changes nothing (no-op close must not rewrite the record). */
export function completeRun(db: DB, id: number, outcome: string, note?: string): CompleteResult {
  if (!(OUTCOMES as readonly string[]).includes(outcome)) return "bad_outcome";
  const text = note && note.trim() ? `${outcome}: ${note.trim().replace(/\s+/g, " ").slice(0, NOTE_MAX)}` : outcome;
  const r = db.prepare(`UPDATE task_runs SET completed_at = unixepoch(), outcome = ? WHERE id = ? AND completed_at IS NULL`).run(text, id);
  if (r.changes > 0) return "ok";
  const exists = db.prepare(`SELECT 1 FROM task_runs WHERE id = ?`).get(id);
  return exists ? "already" : "missing";
}

export interface UnfinishedRun {
  id: number;
  name: string;
  agent: string;
  ts: number;
  fired_at: number;
  delivery: string | null;
}

/** Runs that expected completion, are still open, were never alarmed, and were FIRED more than `afterMin` and less than `maxAgeH` hours ago (fire time, not the occurrence time). The upper bound keeps a backlog
 * (shadow mode, an outage) from being digested when alarms are switched on. Oldest first, capped. */
export function findUnfinished(db: DB, nowSec: number, afterMin: number, limit: number, maxAgeH = 12): UnfinishedRun[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.agent, t.ts, t.fired_at, i.status AS delivery
         FROM task_runs t LEFT JOIN inbound_queue i ON i.id = t.inbound_id
        WHERE t.expects_completion = 1 AND t.completed_at IS NULL AND t.alarmed_at IS NULL AND t.fired_at <= ? AND t.fired_at >= ?
        ORDER BY t.fired_at ASC LIMIT ?`
    )
    .all(nowSec - afterMin * 60, nowSec - maxAgeH * 3600, limit) as UnfinishedRun[];
  return rows;
}

export function markAlarmed(db: DB, id: number, delivery: string | null): void {
  db.prepare(`UPDATE task_runs SET alarmed_at = unixepoch(), delivery = ? WHERE id = ? AND alarmed_at IS NULL`).run(delivery, id);
}

function runLine(r: UnfinishedRun, nowSec: number): string {
  const min = Math.max(1, Math.round((nowSec - r.fired_at) / 60));
  const how = r.delivery === "queued" ? "prompt still queued, never delivered" : r.delivery ? `prompt ${r.delivery}` : "delivery unknown";
  return `- "${r.name}" (agent ${r.agent}, run #${r.id}): fired ${min} min ago, ${how}`;
}

/** ONE message per sweep, however many runs: the bus rate breakers must never see a burst of alarms. */
export function alarmDigest(rows: UnfinishedRun[], nowSec: number): string {
  const head = rows.length === 1 ? "A scheduled task fired but was never marked complete:" : `${rows.length} scheduled tasks fired but were never marked complete:`;
  return `[task-completion] ${head}\n${rows.map((r) => runLine(r, nowSec)).join("\n")}\nCheck whether each ran; if it did, close it: POST /api/task-runs/<run id>/complete.`;
}

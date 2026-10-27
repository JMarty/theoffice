import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, ScheduledTaskType } from "../types.js";
import { enqueueInbound } from "../queue/index.js";
import { sendAgentMessage } from "../bus/index.js";
import { guardDecision } from "../quota/guard.js";
import { alarmDigest, completionInstruction, expectsCompletion, findUnfinished, markAlarmed } from "./completion.js";
import { getDb } from "../db/index.js";
import { isDueNow, minuteKey, lastOccurrenceBefore } from "./cron.js";
import { log } from "../logger.js";

const logger = log("scheduler");
const TICK_MS = 30_000; // sub-minute; per-minute dedup makes double-fire impossible
// Boot catch-up looks back at most this far for occurrences missed while the engine was down — bounds the
// work and avoids replaying ancient misses after a long outage.
const CATCHUP_MAX_MS = 6 * 60 * 60 * 1000;
const SWEEP_MAX = 5; // alarms per tick: a backlog (e.g. after an outage) cannot flood the main agent

export interface ScheduledTask {
  name: string;
  description?: string;
  schedule: string; // 5-field cron
  agent: string;
  type: ScheduledTaskType; // 'task' (always reports) | 'heartbeat' (notify only if important)
  enabled: boolean;
  prompt: string;
  /** 'background' marks a task nobody is waiting on, so the quota guard may defer it like a heartbeat */
  quota?: "background";
}

interface TaskConfig {
  name?: string;
  description?: string;
  schedule?: string;
  agent?: string;
  type?: ScheduledTaskType;
  enabled?: boolean;
  prompt?: string;
  quota?: string;
}

/**
 * Load file-based scheduled tasks from tenant/scheduled-tasks/<name>/.
 * Each dir has task-config.json (+ optional SKILL.md for the prompt body).
 * This file layout is the source of truth (the legacy DB table is dropped).
 */
export function loadScheduledTasks(cfg: EngineConfig): ScheduledTask[] {
  const root = cfg.paths.scheduledTasksDir;
  if (!existsSync(root)) return [];
  const out: ScheduledTask[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const dir = join(root, ent.name);
    const cfgPath = join(dir, "task-config.json");
    if (!existsSync(cfgPath)) continue;
    let tc: TaskConfig;
    try {
      tc = JSON.parse(readFileSync(cfgPath, "utf8")) as TaskConfig;
    } catch (err) {
      logger.warn({ task: ent.name, err }, "bad task-config.json, skipping");
      continue;
    }
    if (!tc.schedule) continue;
    let prompt = tc.prompt ?? "";
    const skillPath = join(dir, "SKILL.md");
    if (!prompt && existsSync(skillPath)) prompt = readFileSync(skillPath, "utf8");
    out.push({
      name: tc.name ?? ent.name,
      description: tc.description,
      schedule: tc.schedule,
      agent: tc.agent ?? cfg.mainAgentId,
      type: tc.type === "heartbeat" ? "heartbeat" : "task",
      enabled: tc.enabled !== false,
      prompt,
      ...(tc.quota === "background" ? { quota: "background" as const } : {}),
    });
  }
  return out;
}

function wrap(task: ScheduledTask, runId?: number): string {
  const header =
    task.type === "heartbeat"
      ? `[Scheduled heartbeat: ${task.name}] Silent check — only message the owner if something is genuinely important or time-sensitive. Otherwise do the check and stay quiet.`
      : `[Scheduled task: ${task.name}] Run this now and report the result to the owner.`;
  return `${header}\n\n${task.prompt}`.trim() + (runId != null ? completionInstruction(runId) : "");
}

/**
 * Record the run, then enqueue its prompt carrying the run id. The run row comes first because the prompt needs its id;
 * a deduped enqueue (same minute already fired) removes the row again, so a duplicate never leaves an open orphan.
 */
function fireOne(cfg: EngineConfig, t: ScheduledTask, tsSec: number, dedupKey: string): number | undefined {
  // Quota guard: only background work (heartbeats, tasks marked quota:"background") can be deferred; tasks that report to the owner always run.
  const g = guardDecision(cfg, t.type === "heartbeat" || t.quota === "background" ? "background" : "owner-facing", Date.now());
  if (!g.run) {
    logger.warn({ task: t.name, agent: t.agent, reason: g.reason }, "quota guard: background work deferred");
    return undefined;
  }
  if (g.wouldDefer) logger.info({ task: t.name, agent: t.agent, reason: g.reason }, "quota guard (shadow): would defer");
  const db = getDb();
  const completion = cfg.taskCompletion?.enabled !== false;
  const run = db
    .prepare(`INSERT INTO task_runs (name, agent, ts, fired_at, expects_completion) VALUES (?, ?, ?, unixepoch(), ?)`)
    .run(t.name, t.agent, tsSec, completion ? expectsCompletion(t.type) : 0);
  const runId = Number(run.lastInsertRowid);
  const id = enqueueInbound({ agentId: t.agent, source: "scheduler", prompt: wrap(t, completion && t.type === "task" ? runId : undefined), dedupKey });
  if (id == null) {
    db.prepare(`DELETE FROM task_runs WHERE id = ?`).run(runId);
    return undefined;
  }
  db.prepare(`UPDATE task_runs SET inbound_id = ? WHERE id = ?`).run(id, runId);
  return id;
}

/** Alarm the main agent with ONE digest (each run once) about task runs that fired but were never marked complete. */
export function sweepUnfinished(cfg: EngineConfig, nowMs: number): number {
  if (cfg.taskCompletion?.enabled === false || cfg.taskCompletion?.alarm === false) return 0; // shadow mode: instruction + records, no alarm
  const db = getDb();
  const nowSec = Math.floor(nowMs / 1000);
  const rows = findUnfinished(db, nowSec, cfg.taskCompletion?.alarmAfterMin ?? 30, SWEEP_MAX, cfg.taskCompletion?.alarmMaxAgeH ?? 12);
  if (!rows.length) return 0;
  sendAgentMessage(cfg.mainAgentId, cfg.mainAgentId, alarmDigest(rows, nowSec)); // one digest, not N messages (bus breakers)
  for (const r of rows) {
    markAlarmed(db, r.id, r.delivery);
    logger.warn({ run: r.id, task: r.name, agent: r.agent, delivery: r.delivery }, "scheduled task fired but never completed");
  }
  return rows.length;
}

/** Fire any tasks due in the current minute (idempotent via inbound dedup key). */
export function fireDueTasks(cfg: EngineConfig, nowMs: number): number {
  const tasks = loadScheduledTasks(cfg).filter((t) => t.enabled && t.prompt);
  const mk = minuteKey(nowMs);
  let fired = 0;
  for (const t of tasks) {
    if (!isDueNow(t.schedule, nowMs, cfg.owner.timezone)) continue;
    const id = fireOne(cfg, t, Math.floor(nowMs / 1000), `sched:${t.name}:${mk}`);
    if (id != null) {
      fired++;
      logger.info({ task: t.name, agent: t.agent, type: t.type }, "scheduled task fired");
    }
  }
  return fired;
}

function getLastTick(): number | null {
  const r = getDb().prepare(`SELECT v FROM scheduler_state WHERE k='last_tick'`).get() as { v: number } | undefined;
  return r ? r.v : null;
}
function setLastTick(ms: number): void {
  getDb()
    .prepare(`INSERT INTO scheduler_state (k, v) VALUES ('last_tick', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
    .run(ms);
}

/**
 * Boot catch-up (#16): fire occurrences that fell while the engine was DOWN. For each enabled task we take
 * the single MOST-RECENT occurrence before the current minute; if it landed in the gap (lastTick, now]
 * (bounded to CATCHUP_MAX_MS) AND task_runs shows it did NOT already fire, we fire it once.
 *
 * No-double-fire: we (a) consult task_runs for that occurrence's minute BEFORE
 * firing, and (b) enqueue with the SAME per-minute dedup key the on-time path uses, so an occurrence the
 * normal fire already handled is suppressed by both guards. We fire only the LATEST missed occurrence per
 * task (not a backlog replay) so a frequent task can't flood the fleet after a long outage.
 */
export function catchUpMissed(cfg: EngineConfig, nowMs: number): number {
  const lastTick = getLastTick();
  if (lastTick == null) return 0; // first boot ever -> no prior run to catch up from
  const since = Math.max(lastTick, nowMs - CATCHUP_MAX_MS);
  const nowMin = nowMs - (nowMs % 60000);
  const db = getDb();
  let fired = 0;
  for (const t of loadScheduledTasks(cfg).filter((x) => x.enabled && x.prompt)) {
    const occ = lastOccurrenceBefore(t.schedule, nowMin, cfg.owner.timezone);
    if (occ == null || occ <= since) continue; // no occurrence missed inside the catch-up window
    const occSec = Math.floor(occ / 1000);
    const already = db.prepare(`SELECT 1 FROM task_runs WHERE name=? AND ts>=? AND ts<? LIMIT 1`).get(t.name, occSec, occSec + 60);
    if (already) continue; // already fired (on-time or a prior catch-up) -> do NOT re-fire
    const id = fireOne(cfg, t, occSec, `sched:${t.name}:${minuteKey(occ)}`);
    if (id != null) {
      fired++;
      logger.warn({ task: t.name, agent: t.agent, occMin: minuteKey(occ), lateBySec: Math.floor((nowMs - occ) / 1000) }, "catch-up: fired an occurrence missed while the engine was down");
    }
  }
  return fired;
}

export function startScheduler(cfg: EngineConfig): () => void {
  let stopped = false;
  // Fire anything missed while the engine was down, BEFORE starting the regular cadence.
  try {
    const n = catchUpMissed(cfg, Date.now());
    if (n > 0) logger.warn({ caughtUp: n }, "scheduler boot catch-up");
  } catch (err) {
    logger.error({ err }, "scheduler catch-up error");
  }
  setLastTick(Date.now());

  const tick = () => {
    if (stopped) return;
    try {
      fireDueTasks(cfg, Date.now());
      sweepUnfinished(cfg, Date.now());
      setLastTick(Date.now()); // advance the catch-up watermark each live tick
    } catch (err) {
      logger.error({ err }, "scheduler tick error");
    }
  };
  const handle = setInterval(tick, TICK_MS);
  logger.info({ tickMs: TICK_MS, tz: cfg.owner.timezone }, "scheduler started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

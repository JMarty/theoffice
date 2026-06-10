import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, ScheduledTaskType } from "../types.js";
import { enqueueInbound } from "../queue/index.js";
import { getDb } from "../db/index.js";
import { isDueNow, minuteKey } from "./cron.js";
import { log } from "../logger.js";

const logger = log("scheduler");
const TICK_MS = 30_000; // sub-minute; per-minute dedup makes double-fire impossible

export interface ScheduledTask {
  name: string;
  description?: string;
  schedule: string; // 5-field cron
  agent: string;
  type: ScheduledTaskType; // 'task' (always reports) | 'heartbeat' (notify only if important)
  enabled: boolean;
  prompt: string;
}

interface TaskConfig {
  name?: string;
  description?: string;
  schedule?: string;
  agent?: string;
  type?: ScheduledTaskType;
  enabled?: boolean;
  prompt?: string;
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
    });
  }
  return out;
}

function wrap(task: ScheduledTask): string {
  const header =
    task.type === "heartbeat"
      ? `[Scheduled heartbeat: ${task.name}] Silent check — only message the owner if something is genuinely important or time-sensitive. Otherwise do the check and stay quiet.`
      : `[Scheduled task: ${task.name}] Run this now and report the result to the owner.`;
  return `${header}\n\n${task.prompt}`.trim();
}

/** Fire any tasks due in the current minute (idempotent via inbound dedup key). */
export function fireDueTasks(cfg: EngineConfig, nowMs: number): number {
  const tasks = loadScheduledTasks(cfg).filter((t) => t.enabled && t.prompt);
  const mk = minuteKey(nowMs);
  let fired = 0;
  for (const t of tasks) {
    if (!isDueNow(t.schedule, nowMs, cfg.owner.timezone)) continue;
    const id = enqueueInbound({
      agentId: t.agent,
      source: "scheduler",
      prompt: wrap(t),
      dedupKey: `sched:${t.name}:${mk}`,
    });
    if (id != null) {
      getDb().prepare(`INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)`).run(t.name, t.agent, Math.floor(nowMs / 1000));
      fired++;
      logger.info({ task: t.name, agent: t.agent, type: t.type }, "scheduled task fired");
    }
  }
  return fired;
}

export function startScheduler(cfg: EngineConfig): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      fireDueTasks(cfg, Date.now());
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

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { EngineConfig } from "../types.js";
import { log } from "../logger.js";
import { sendAgentMessage } from "../bus/index.js";
import { decideQuotaAction, QUOTA_DEFAULTS, type QuotaConfig, type QuotaSnapshot, type QuotaWorkClass } from "./gate.js";
import { fetchUsageSnapshot, readAccessToken } from "./snapshot.js";
import { decideRotation, swapCredentials, ROTATION_DEFAULTS, type PlanReading } from "./rotation.js";

const logger = log("quota");
const REFRESH_MS = 5 * 60_000;

let latest: QuotaSnapshot | null = null;
export const setSnapshotForTest = (s: QuotaSnapshot | null): void => { latest = s; };
export const resetGuardForTest = (): void => { latest = null; };

export interface GuardDecision {
  /** false only in enforce mode when background work should be deferred */
  run: boolean;
  /** would the guard defer if it were enforcing (shadow mode reports this while still running) */
  wouldDefer: boolean;
  reason: string;
}

const liveCredentials = (cfg: EngineConfig): string => cfg.quotaGuard?.credentialsFile ?? join(homedir(), ".claude", ".credentials.json");

function thresholds(cfg: EngineConfig): QuotaConfig {
  const g = cfg.quotaGuard;
  return { ...QUOTA_DEFAULTS, ...(g?.deferAtPercent != null ? { deferAtPercent: g.deferAtPercent } : {}), ...(g?.nearResetPercent != null ? { nearResetPercent: g.nearResetPercent } : {}) };
}

/** Synchronous decision from the last fetched snapshot. Off unless cfg.quotaGuard.enabled; shadow unless mode is "enforce". */
export function guardDecision(cfg: EngineConfig, workClass: QuotaWorkClass, nowMs: number): GuardDecision {
  if (!cfg.quotaGuard?.enabled) return { run: true, wouldDefer: false, reason: "disabled" };
  const d = decideQuotaAction({ snapshot: latest, nowMs, workClass, config: thresholds(cfg) });
  const wouldDefer = d.action === "defer";
  return { run: !(wouldDefer && cfg.quotaGuard.mode === "enforce"), wouldDefer, reason: d.reason };
}

function planFile(cfg: EngineConfig): string { return join(cfg.paths.storeDir, "claude-plans.json"); }
interface PlanState { active: string; switchedAtMs: number | null }
function readPlanState(cfg: EngineConfig): PlanState {
  try { return JSON.parse(readFileSync(planFile(cfg), "utf8")) as PlanState; } catch { return { active: cfg.claudePlans?.plans[0]?.id ?? "", switchedAtMs: null }; }
}

let lastRotationNote = "";
/** One refresh: fetch the active plan's usage, persist it for observability, then evaluate rotation (if plans are configured). */
export async function refreshQuota(cfg: EngineConfig, fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<void> {
  const token = readAccessToken(liveCredentials(cfg), nowMs);
  latest = token ? await fetchUsageSnapshot(token, fetchImpl, nowMs) : null;
  try {
    mkdirSync(cfg.paths.storeDir, { recursive: true });
    writeFileSync(join(cfg.paths.storeDir, "quota-latest.json"), JSON.stringify({ at: new Date(nowMs).toISOString(), snapshot: latest }, null, 1));
  } catch { /* observability only */ }
  const plans = cfg.claudePlans;
  if (!plans || plans.plans.length < 2) return;
  const state = readPlanState(cfg);
  const readings: PlanReading[] = [];
  for (const p of plans.plans) {
    if (p.id === state.active) { readings.push({ id: p.id, snapshot: latest }); continue; }
    const t = readAccessToken(p.credentialsFile, nowMs);
    readings.push({ id: p.id, snapshot: t ? await fetchUsageSnapshot(t, fetchImpl, nowMs) : null });
  }
  const d = decideRotation({ activeId: state.active, plans: readings, lastSwitchMs: state.switchedAtMs, nowMs, config: { ...ROTATION_DEFAULTS, ...(plans.rotateAtPercent != null ? { rotateAtPercent: plans.rotateAtPercent } : {}) } });
  if (d.action !== "rotate") return;
  const note = `${state.active}->${d.to}`;
  const act = plans.mode === "act";
  if (act) {
    const out = plans.plans.find((p) => p.id === state.active)!, inc = plans.plans.find((p) => p.id === d.to)!;
    swapCredentials({ liveFile: liveCredentials(cfg), outgoingFile: out.credentialsFile, incomingFile: inc.credentialsFile });
    writeFileSync(planFile(cfg), JSON.stringify({ active: d.to, switchedAtMs: nowMs }));
  }
  if (note !== lastRotationNote || act) {
    lastRotationNote = note;
    sendAgentMessage(cfg.mainAgentId, cfg.mainAgentId,
      act ? `[plan-rotation] Switched Claude plan ${state.active} -> ${d.to} (${d.reason}). Agent sessions keep the old login until restarted: run the claude-agent-auth-restart procedure.`
          : `[plan-rotation] Observe mode: would switch Claude plan ${state.active} -> ${d.to} (${d.reason}). Set claudePlans.mode to "act" to let the engine do it.`);
  }
  logger.warn({ from: state.active, to: d.to, act, reason: d.reason }, "plan rotation decision");
}

export function startQuotaRefresher(cfg: EngineConfig): () => void {
  if (!cfg.quotaGuard?.enabled) return () => {};
  const run = () => { refreshQuota(cfg).catch((err) => logger.error({ err }, "quota refresh error")); };
  run();
  const h = setInterval(run, REFRESH_MS);
  return () => clearInterval(h);
}

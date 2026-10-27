import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { QUOTA_DEFAULTS, quotaPressure, type QuotaSnapshot } from "./gate.js";

/**
 * Plan rotation: with several Claude plans, move the fleet to another one when the active plan is spent. Shipped
 * behind config (cfg.claudePlans) and in OBSERVE mode by default: the decision is made and reported, nothing is
 * swapped until the tenant sets mode "act". Pure decision + a credentials swap that is tested on temp files.
 */
export interface RotationConfig {
  /** rotate away once the active plan's busiest window is at or above this */
  rotateAtPercent: number;
  /** only rotate to a plan whose busiest window is below this */
  targetBelowPercent: number;
  /** minutes to hold after a switch so two spent plans cannot flap */
  minHoldMin: number;
  staleAfterMs: number;
}
export const ROTATION_DEFAULTS: RotationConfig = { rotateAtPercent: 97, targetBelowPercent: 80, minHoldMin: 60, staleAfterMs: QUOTA_DEFAULTS.staleAfterMs };

export interface PlanReading { id: string; snapshot: QuotaSnapshot | null }
export type RotationDecision = { action: "stay"; reason: string } | { action: "rotate"; to: string; reason: string };

const fresh = (s: QuotaSnapshot | null, nowMs: number, staleAfterMs: number): s is QuotaSnapshot =>
  !!s && s.source.toLowerCase() === "authoritative" && nowMs - s.fetchedAtMs <= staleAfterMs && quotaPressure(s) !== null;

export function decideRotation(i: { activeId: string; plans: PlanReading[]; lastSwitchMs: number | null; nowMs: number; config?: RotationConfig }): RotationDecision {
  const cfg = i.config ?? ROTATION_DEFAULTS;
  const active = i.plans.find((p) => p.id === i.activeId);
  if (!active || !fresh(active.snapshot, i.nowMs, cfg.staleAfterMs)) return { action: "stay", reason: "active plan state unknown" };
  const used = quotaPressure(active.snapshot)!;
  if (used < cfg.rotateAtPercent) return { action: "stay", reason: `active plan at ${used}%` };
  if (i.lastSwitchMs != null && i.nowMs - i.lastSwitchMs < cfg.minHoldMin * 60_000) return { action: "stay", reason: "holding after a recent switch" };
  const candidates = i.plans
    .filter((p) => p.id !== i.activeId && fresh(p.snapshot, i.nowMs, cfg.staleAfterMs) && quotaPressure(p.snapshot)! < cfg.targetBelowPercent)
    .sort((x, y) => quotaPressure(x.snapshot)! - quotaPressure(y.snapshot)!);
  if (!candidates.length) return { action: "stay", reason: `active plan at ${used}% but no other plan has headroom` };
  return { action: "rotate", to: candidates[0]!.id, reason: `active plan at ${used}%, ${candidates[0]!.id} at ${quotaPressure(candidates[0]!.snapshot)}%` };
}

function assertCredentials(file: string): string {
  const raw = readFileSync(file, "utf8");
  const c = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth;
  if (!c?.accessToken) throw new Error(`not a Claude credentials file: ${file}`);
  return raw;
}

/**
 * Install the incoming plan's credentials as the live file. The live file holds the OUTGOING plan's freshest tokens
 * (Claude Code refreshes them in place), so they are saved back to the outgoing plan's own file first; the incoming
 * file is validated before anything is touched, and the live file is replaced atomically (0600). Throws, changing
 * nothing, on any invalid input.
 */
export function swapCredentials(p: { liveFile: string; outgoingFile: string; incomingFile: string }): void {
  const incoming = assertCredentials(p.incomingFile);
  const live = assertCredentials(p.liveFile);
  const tmp = `${p.liveFile}.tmp`;
  try {
    writeFileSync(tmp, incoming, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    writeFileSync(p.outgoingFile, live, { mode: 0o600 });
    chmodSync(p.outgoingFile, 0o600);
    renameSync(tmp, p.liveFile);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

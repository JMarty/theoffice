/**
 * Quota-aware dispatch: should this piece of work start right now?
 *
 * The Claude subscription quota is ONE pool for the whole fleet (5-hour and 7-day windows). Background heartbeats
 * are the cheapest and most frequent consumers and can burn the last percent of a window minutes before the owner
 * needs it. Pure decision logic, unit-tested without a network call.
 *
 * Two deliberate rules:
 *  - FAIL OPEN. A missing, stale, untrusted or percentage-less snapshot means "unknown", and unknown never silences
 *    the fleet. Only fresh authoritative evidence of real pressure can stop work.
 *  - ONLY BACKGROUND WORK IS DEFERRED. Anything the owner sees or waits for always runs.
 */
export interface QuotaWindow {
  /** 0..100 */
  usedPercent: number;
  resetsAtMs: number | null;
}

export interface QuotaSnapshot {
  /** 'authoritative' for the OAuth usage endpoint; anything else is a guess and is ignored. */
  source: string;
  fetchedAtMs: number;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
}

export type QuotaWorkClass = "background" | "owner-facing";

export interface QuotaConfig {
  /** snapshot older than this tells us nothing about now */
  staleAfterMs: number;
  /** background work stops at or above this utilization of either window */
  deferAtPercent: number;
  /** ...and from this level if that window resets within nearResetMs (waiting is cheaper than spending the tail) */
  nearResetPercent: number;
  nearResetMs: number;
}

export const QUOTA_DEFAULTS: QuotaConfig = { staleAfterMs: 20 * 60_000, deferAtPercent: 85, nearResetPercent: 70, nearResetMs: 30 * 60_000 };

export interface QuotaDecision {
  action: "run" | "defer";
  reason: string;
  pressure: number | null;
}

export function quotaPressure(s: QuotaSnapshot | null | undefined): number | null {
  const vals = [s?.fiveHour?.usedPercent, s?.sevenDay?.usedPercent].filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}

export function decideQuotaAction(input: { snapshot: QuotaSnapshot | null | undefined; nowMs: number; workClass: QuotaWorkClass; config?: QuotaConfig }): QuotaDecision {
  const { snapshot, nowMs, workClass } = input;
  const cfg = input.config ?? QUOTA_DEFAULTS;
  if (workClass === "owner-facing") return { action: "run", reason: "owner-facing", pressure: quotaPressure(snapshot) };
  if (!snapshot) return { action: "run", reason: "no-snapshot", pressure: null };
  if (snapshot.source.toLowerCase() !== "authoritative") return { action: "run", reason: "untrusted-source", pressure: null };
  if (nowMs - snapshot.fetchedAtMs > cfg.staleAfterMs) return { action: "run", reason: "stale-snapshot", pressure: null };
  const pressure = quotaPressure(snapshot);
  if (pressure === null) return { action: "run", reason: "no-percentages", pressure: null };
  if (pressure >= cfg.deferAtPercent) return { action: "defer", reason: `at ${pressure}% (threshold ${cfg.deferAtPercent}%)`, pressure };
  for (const [name, w] of [["5h", snapshot.fiveHour], ["7d", snapshot.sevenDay]] as const) {
    if (!w || w.resetsAtMs == null) continue;
    const msLeft = w.resetsAtMs - nowMs;
    if (msLeft > 0 && msLeft <= cfg.nearResetMs && w.usedPercent >= cfg.nearResetPercent) {
      return { action: "defer", reason: `${name} window at ${w.usedPercent}% resets in ${Math.round(msLeft / 60_000)} min`, pressure };
    }
  }
  return { action: "run", reason: "below-threshold", pressure };
}

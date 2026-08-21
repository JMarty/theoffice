// Auth watchdog — notices the fleet has lost its Claude login and TELLS THE OWNER, unprompted.
//
// The 2026-07-25 outage was silent: every agent was signed out for ~20 minutes and nothing anywhere
// said so. The dashboard was green, and the agents themselves obviously couldn't report the problem —
// they were the thing that was broken.
//
// The engine is the right place for this because it is the ONE component that keeps working during a
// Claude auth outage: the Slack sender posts through the agents' bot tokens (Slack credentials), which
// have nothing to do with the Claude credential. So the engine can still speak even when no agent can.
//
// Two jobs:
//   1. ALERT — DM the owner (as the main agent's bot) when the credential expires, is close to
//      expiring, or panes are found signed out. Rate-limited so it never becomes a pager storm.
//   2. SELF-HEAL — when the credential is VALID but panes are stale (the exact "a restart would fix
//      this" case), quietly restart those panes. That is the one failure mode that needs no human.

import type { EngineConfig } from "../types.js";
import { enqueueOutbound } from "../queue/index.js";
import { getAuthHealth, restartSignedOutAgents, trackBusySkips, formatDuration } from "./claude-auth.js";
import { log } from "../logger.js";

const logger = log("auth-watchdog");

const CHECK_MS = 5 * 60 * 1000;
/** Re-alert cadence, per severity. Hard-down states (expired / no-credential / panes signed out)
 *  page HOURLY until fixed — the fleet is mute, the owner needs nagging. But the non-urgent
 *  "expiring-soon" heads-up (nothing is broken, days of runway) must never become hourly spam;
 *  it repeats only inside the fixed local windows below. A status change still alerts immediately,
 *  so a degrade from expiring-soon → hard-down pages at once regardless of either window. */
const REALERT_MS_URGENT = 60 * 60 * 1000;

/**
 * Repeat reminders about the SAME unchanged expiring-soon warning are capped at two a day, in these
 * local hours. The owner asked for this on 2026-08-21, after an hourly repeat sent 14 identical DMs
 * in 13 hours, overnight included: an alert that arrives every hour stops being information and just
 * burns attention. Fixed LOCAL hours, not a 24h timer from the last send — a relative timer drifts
 * (2:57 → 2:57 the next night) and lands back in the small hours, which was the original complaint.
 * Note this caps REPEATS only — see dueForAlert.
 */
export const ALERT_HOURS: readonly number[] = [8, 20];

/** Identifies one reminder window, e.g. "2026-08-21:8". null outside the windows. */
export function alertSlot(now: Date): string | null {
  const h = now.getHours();
  if (!ALERT_HOURS.includes(h)) return null;
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}:${h}`;
}

/**
 * A problem we have NOT reported yet is told immediately — a credential that just died must not wait
 * until the evening window. Anything we have already said repeats only inside a window, once per
 * window, which is what makes it two a day instead of twenty-four.
 */
export function dueForAlert(a: {
  status: string;
  lastStatus: string;
  slot: string | null;
  lastSlot: string;
}): boolean {
  if (a.status !== a.lastStatus) return true;
  return a.slot !== null && a.slot !== a.lastSlot;
}
/** Self-heal is capped so a genuinely broken agent can't be restart-looped forever. */
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;
/** Consecutive ticks an agent may be skipped as busy before the owner hears about it (6 = 30 min). */
const BUSY_ESCALATE_TICKS = 6;
/**
 * Re-alert key for "signed out but mid-task", kept LOCAL to the watchdog on purpose. Promoting it
 * into getAuthHealth would change the /api/auth/health contract and make the dashboard banner draw
 * its "agents need a restart" variant for a case where a restart is exactly what we refuse to do.
 */
const BUSY_ALERT_STATUS = "agents-signed-out-busy";

export function startAuthWatchdog(cfg: EngineConfig): () => void {
  let stopped = false;
  let lastAlertStatus = "";
  let lastAlertAt = 0;
  /** Reminder window whose one allowed repeat has already been sent. */
  let lastAlertSlot = "";
  let lastHealAt = 0;
  /** agent id -> consecutive ticks it was signed out AND mid-task, so the watchdog left it alone. */
  let busySkips = new Map<string, number>();

  const alert = (text: string) => {
    const channel = cfg.owner.slackUserId;
    if (!channel) {
      logger.error("no owner slack id configured — cannot alert about auth");
      return;
    }
    try {
      enqueueOutbound(cfg.mainAgentId, channel, text);
    } catch (err) {
      logger.error({ err }, "could not enqueue auth alert");
    }
  };

  const tick = () => {
    if (stopped) return;
    let health;
    try {
      health = getAuthHealth(cfg);
    } catch (err) {
      logger.error({ err }, "auth health check failed");
      return;
    }

    if (health.ok) {
      // Recovered — allow the next incident to alert immediately.
      if (lastAlertStatus) logger.info("auth healthy again");
      lastAlertStatus = "";
      lastAlertSlot = "";
      busySkips = new Map();
      return;
    }

    const now = Date.now();

    // --- self-heal: credential good, panes stale. No human needed. ---
    if (health.restartWouldFix && now - lastHealAt > HEAL_COOLDOWN_MS) {
      logger.warn({ count: health.signedOutCount }, "auth-watchdog: credential valid but panes signed out — self-healing");
      const r = restartSignedOutAgents(cfg);
      const track = trackBusySkips(r.skippedBusy, busySkips, BUSY_ESCALATE_TICKS);
      busySkips = track.next;

      // Every candidate was mid-turn, so nothing was touched. Don't burn the cooldown on a no-op
      // and don't page the owner about work that didn't happen: just look again on the next tick,
      // by which point the pane has almost certainly gone idle on its own.
      if (r.restarted.length === 0 && r.failed.length === 0 && r.skippedBusy.length > 0) {
        if (track.escalate.length === 0) {
          logger.info({ skippedBusy: r.skippedBusy }, "auth-watchdog: all candidates busy — deferring to next tick");
          return;
        }

        // Deferring forever is its own outage. lastHealAt is deliberately NOT touched on this path,
        // so the gate above stays open and every later tick lands here too — without this exit the
        // alert below would be unreachable for as long as the pane stays busy, and the fleet could
        // sit half-dead in silence. The counter is NOT reset afterwards: the re-alert window is the
        // one and only repeat interval, so a still-stuck agent produces one reminder an hour.
        const shouldAlert = lastAlertStatus !== BUSY_ALERT_STATUS || now - lastAlertAt > REALERT_MS_URGENT;
        if (!shouldAlert) return;
        lastAlertStatus = BUSY_ALERT_STATUS;
        lastAlertAt = now;
        // Its own text, never health.message: that one ends with "restarting them picks the login
        // up", which is precisely the action the busy guard is refusing to take.
        alert(
          `⏳ ${track.escalate.join(", ")} has looked signed out for over ` +
            `${formatDuration((BUSY_ESCALATE_TICKS * CHECK_MS) / 1000)}, but has been mid-task the whole time, ` +
            `so I have NOT touched it — restarting an agent mid-turn destroys the conversation it is having.\n` +
            `The Claude login itself is valid. Have a look when you can: it is either genuinely working, ` +
            `or its pane is wedged and needs you.`,
        );
        logger.error({ status: BUSY_ALERT_STATUS, agents: track.escalate }, "auth-watchdog: alerted owner");
        return;
      }

      lastHealAt = now;
      alert(
        `🔧 Auto-repair: ${r.restarted.length} agent(s) were still signed out even though the Claude login is valid. ` +
          `I restarted them (${r.restarted.join(", ") || "none"}). No action needed from you.` +
          (r.skippedBusy.length ? `\n⏳ Left alone because they were mid-task: ${r.skippedBusy.join(", ")}` : "") +
          (r.failed.length ? `\n⚠️ Could NOT restart: ${r.failed.join(", ")}` : ""),
      );
      return;
    }

    // --- alert: needs the owner to actually sign in ---
    // Severity decides the REPEAT cadence; a status change alerts immediately on either path.
    // hard-down (expired / no-credential / signed-out panes): hourly until someone acts — the fleet
    // is mute, so nagging is the point. expiring-soon: nothing is broken and there are days of
    // runway, so it repeats only inside ALERT_HOURS, twice a day, never overnight.
    const slot = alertSlot(new Date(now));
    const expiring = health.status === "expiring-soon";
    const due = expiring
      ? dueForAlert({ status: health.status, lastStatus: lastAlertStatus, slot, lastSlot: lastAlertSlot })
      : health.status !== lastAlertStatus || now - lastAlertAt > REALERT_MS_URGENT;
    if (!due) return;
    lastAlertStatus = health.status;
    lastAlertAt = now;
    if (expiring && slot) lastAlertSlot = slot;

    if (health.status === "expiring-soon") {
      alert(
        `⏳ Heads up: the fleet's Claude login must be renewed within ${formatDuration(health.credential.refreshExpiresInSec ?? 0)}.\n` +
          `Nothing is broken yet. Open the dashboard → **Sign in to Claude** at a moment that suits you — ` +
          `if it lapses instead, every agent goes silent at once.`,
      );
    } else {
      alert(
        `🔴 THE FLEET CANNOT AUTHENTICATE — ${health.message}\n\n` +
          `No agent can answer you until this is fixed. You do NOT need a terminal:\n` +
          `open the dashboard → red **Sign in to Claude** banner → follow the link → paste the code.\n` +
          `Everything restarts automatically afterwards.`,
      );
    }
    logger.error({ status: health.status }, "auth-watchdog: alerted owner");
  };

  // Give the fleet a moment to settle after boot before the first judgement.
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, CHECK_MS);
  logger.info("auth watchdog started");
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

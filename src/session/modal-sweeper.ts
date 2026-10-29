// Session-hygiene sweeper — the periodic backstop born from a delivery outage.
//
// Jobs the isReady-gated deliver path structurally cannot do, because a blocked pane makes the
// deliverer bail BEFORE it can act, and because some failures never touch the deliverer at all:
//
//   1. OWNER-DELIVERY WATCHDOG (the load-bearing one). An owner (source='channel') message must never go
//      unheard. A single STATE-OBSERVER alarms the owner when a channel row is EITHER (a) dropped
//      (status=failed) OR (b) still queued and undelivered past a threshold. (b) is the case the outage
//      actually hit — messages parked behind a modal, never attempted, so never 'failed' — which an
//      alarm keyed only on 'failed' would have missed entirely. It also backstops the modal
//      detectors failing open: if a future Claude Code changes the modal wording, nothing dismisses, the
//      pane reads generic 'unknown', delivery gates shut — and the age alarm still fires. The alarm is
//      PANE-INDEPENDENT (posted via the Slack bot to the owner, like auth-watchdog) because the failure
//      cause IS a broken pane; re-delivering into it is what already failed.
//
//   2. Dismiss the usage-limit modal — but ONLY when the highlight is provably on Stop-and-wait
//      (detectsUsageLimitModal). Any other arrangement is left untouched: the sweeper is structurally
//      incapable of selecting Upgrade (spending the owner's money).
//
//   3. Detect a permission/approval prompt and ALARM — NEVER dismiss it. Clearing one grants an
//      authorisation (delete/push/payment/deploy) blind. Freezing is the safe failure; a human decides.
//
//   3b. Submit a STUCK PENDING PASTE: a multi-line delivery whose Enter was lost leaves `[Pasted text #N]` in
//      the composer; the pane reads "busy" forever and the bus queues behind it.
//      Enter on an idle, non-modal pane with a pending paste is exactly what the lost Enter was meant to do.
//
//   4. Drop stale scheduler heartbeats so a moot briefing isn't delivered ahead of, or instead of, live
//      work. Owner and inter-agent messages are never age-dropped.

import type { EngineConfig } from "../types.js";
import { log } from "../logger.js";
import { listSessions, capturePane, sendKey } from "./tmux.js";
import {
  detectsUsageLimitModal,
  detectsUnsafeUsageLimitModal,
  detectsPermissionPrompt,
  detectsStuckPendingPaste,
} from "./pane-state.js";
import {
  reapStaleScheduler,
  enqueueOutbound,
  listOwnerAlarmable,
  markOwnerAlarmed,
} from "../queue/index.js";
import { ownerDropAlarmText, ownerStallAlarmText, permissionPromptAlarmText } from "../queue/policy.js";

const logger = log("session-hygiene");

const TICK_MS = 20_000;
// Don't press Enter into the same session more than once per this window (guards a mid-render double-capture).
const DISMISS_COOLDOWN_MS = 15_000;
// Re-alarm about the same frozen permission prompt at most this often (a human is needed; don't page every tick).
const PERMISSION_REALARM_MS = 30 * 60 * 1000;
// A pending-paste placeholder must be seen on this many CONSECUTIVE ticks (20 s each) before the sweeper
// presses Enter, so a delivery that is still pressing its own Enter is never raced; then at most this many
// Enters per stuck episode, spaced by the dismiss cooldown, before it only logs.
const STUCK_PASTE_TICKS = 2;
const STUCK_PASTE_MAX_ENTERS = 6;

function envSec(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// A queued owner message not delivered within this many seconds is alarmed as "stuck". Far under the
// hours an unnoticed stall can last. A legitimate long turn can trip it; the alarm is worded as
// "not yet delivered / may be stuck", which is honest either way.
const ownerStaleSec = () => envSec("OFFICE_OWNER_STALE_SEC", 15 * 60);
// Re-alarm a STILL-stuck queued owner message on this cadence (a dropped/failed one alarms once).
const ownerRealarmSec = () => envSec("OFFICE_OWNER_REALARM_SEC", 30 * 60);
// A queued scheduler heartbeat older than this is moot; drop it. Owner/bus/manual/system never dropped.
const staleSchedulerSec = () => envSec("OFFICE_STALE_SCHED_SEC", 2 * 60 * 60);

export function startSessionHygiene(cfg: EngineConfig): () => void {
  const socket = cfg.tmux.socket;
  let stopped = false;
  const lastDismissAt = new Map<string, number>();
  const lastPermAlarmAt = new Map<string, number>();
  const stuckPaste = new Map<string, { ticks: number; enters: number }>();

  // ---- 2 & 3: per-session modal handling ----
  const sweepModals = () => {
    for (const session of listSessions(socket)) {
      if (!session.startsWith("agent-")) continue; // only agent panes
      const pane = capturePane(socket, session);
      if (pane == null) continue;

      // 3. Permission/approval gate: DETECT + ALARM, never a keystroke. Clearing it would blind-approve.
      if (detectsPermissionPrompt(pane)) {
        const now = Date.now();
        if (now - (lastPermAlarmAt.get(session) ?? 0) >= PERMISSION_REALARM_MS) {
          lastPermAlarmAt.set(session, now);
          alarmOwner(cfg, permissionPromptAlarmText(session.replace(/^agent-/, ""), socket, session));
          logger.error({ session }, "permission/approval prompt detected — LEFT UNTOUCHED (a keystroke would blind-approve); alarmed owner");
        }
        continue;
      }

      // 2. Usage-limit modal present but NOT provably highlighted on Stop-and-wait: never press Enter
      // (could confirm Upgrade). Leave it and surface it.
      if (detectsUnsafeUsageLimitModal(pane)) {
        logger.error({ session }, "usage-limit modal present but highlight NOT on Stop-and-wait — left untouched (Enter could select Upgrade); needs a human");
        continue;
      }

      // 3b. A pending paste that never got its Enter. Seen on consecutive ticks, then Enter (bounded).
      if (detectsStuckPendingPaste(pane)) {
        const st = stuckPaste.get(session) ?? { ticks: 0, enters: 0 };
        st.ticks += 1; stuckPaste.set(session, st);
        const t = Date.now();
        if (st.ticks >= STUCK_PASTE_TICKS && st.enters < STUCK_PASTE_MAX_ENTERS && t - (lastDismissAt.get(session) ?? 0) >= DISMISS_COOLDOWN_MS) {
          lastDismissAt.set(session, t); st.enters += 1;
          const ok = sendKey(socket, session, "Enter");
          logger.warn({ session, ok, enters: st.enters, ticks: st.ticks }, "pending pasted text parked in the input box (a delivery's Enter was lost) — sent Enter to submit it");
        } else if (st.enters >= STUCK_PASTE_MAX_ENTERS && st.ticks === STUCK_PASTE_TICKS + STUCK_PASTE_MAX_ENTERS * 2) {
          logger.error({ session }, "pending pasted text is STILL parked after repeated Enters — needs a human (deliveries to this agent are gated behind it)");
        }
        continue;
      }
      stuckPaste.delete(session);

      // 2. Usage-limit modal with the highlight provably on Stop-and-wait: safe to confirm option 1.
      if (!detectsUsageLimitModal(pane)) continue;
      const now = Date.now();
      if (now - (lastDismissAt.get(session) ?? 0) < DISMISS_COOLDOWN_MS) continue;
      lastDismissAt.set(session, now);
      const ok = sendKey(socket, session, "Enter");
      logger.warn({ session, ok }, "usage-limit modal (highlight on Stop-and-wait) — sent Enter to select it (auto-resumes at reset)");
    }
  };

  // ---- 1: owner-delivery watchdog ----
  const watchOwnerDelivery = () => {
    const rows = listOwnerAlarmable(ownerStaleSec(), ownerRealarmSec());
    for (const r of rows) {
      const channel = r.reply_channel ?? cfg.owner.slackUserId;
      if (!channel) {
        logger.error({ id: r.id, agent: r.agent_id }, "owner message needs escalation but NO reply channel / owner slack id — cannot alarm");
        continue;
      }
      const text = r.dropped
        ? ownerDropAlarmText(r.agent_id, `${r.status} after ${r.attempts} attempts`, r.prompt)
        : ownerStallAlarmText(r.agent_id, Math.round(r.age_sec / 60), r.prompt);
      try {
        enqueueOutbound(cfg.mainAgentId, channel, text);
        markOwnerAlarmed(r.id);
        logger.warn({ id: r.id, agent: r.agent_id, dropped: r.dropped, ageSec: r.age_sec }, "owner-delivery watchdog: alarmed owner (pane-independent)");
      } catch (err) {
        logger.error({ err, id: r.id }, "owner-delivery watchdog: failed to enqueue owner alarm (will retry next tick)");
      }
    }
  };

  const tick = () => {
    if (stopped) return;
    try { watchOwnerDelivery(); } catch (err) { logger.error({ err }, "owner-delivery watchdog tick failed"); }
    try { sweepModals(); } catch (err) { logger.error({ err }, "modal sweep failed"); }
    try {
      const dropped = reapStaleScheduler(staleSchedulerSec());
      if (dropped > 0) logger.warn({ dropped }, "dropped stale scheduler heartbeats (moot before delivery)");
    } catch (err) { logger.error({ err }, "stale-scheduler reap failed"); }
  };

  const handle = setInterval(tick, TICK_MS);
  logger.info({ tickMs: TICK_MS, ownerStaleSec: ownerStaleSec(), staleSchedulerSec: staleSchedulerSec() }, "session-hygiene sweeper started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/** Pane-independent owner alarm: post to the owner via the Slack bot (bypasses the broken pane). */
function alarmOwner(cfg: EngineConfig, text: string): void {
  const channel = cfg.owner.slackUserId;
  if (!channel) {
    logger.error("no owner slack id configured — cannot raise a pane-independent alarm");
    return;
  }
  try {
    enqueueOutbound(cfg.mainAgentId, channel, text);
  } catch (err) {
    logger.error({ err }, "failed to enqueue owner alarm");
  }
}

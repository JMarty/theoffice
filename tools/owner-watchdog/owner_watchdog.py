#!/usr/bin/env python3
"""owner-watchdog (Darryl, 2026-08-19) — catch owner messages that were DELIVERED to an
agent whose turn then died mid-reply WITHOUT the tmux session dying.

Why this exists (the gap two existing engine watchdogs both miss):
  * queue/index.ts  listOwnerAlarmable  -> alarms only 'failed' / 'queued'-stuck rows;
                                           it EXPLICITLY skips 'delivered' rows.
  * queue/orphan.ts decideOrphan        -> requeues 'delivered' rows only when the receiving
                                           SESSION INSTANCE is gone (OOM / relaunch). A transient
                                           API 529 that kills the TURN but leaves the tmux session
                                           alive (same instance) hits gate #3 -> "leave".
  So: delivered + same session alive + turn died + zero reply  == unheard, by BOTH. That is the
  exact shape of the 2026-08-19 "40 minutes of silence" incident. This watchdog owns that niche.

Dedup rule (the orchestrator, load-bearing): ACT ONLY when there is ZERO agent outbound since the message
was delivered (identical to orphan.ts gate #5: lastOutbound > delivered -> leave). If the agent
has spoken at all since delivery, it was alive and working past it -> never re-send.

TURN-ENDED GATE (added 2026-09-25): both actions ALSO require the agent's turn to have ENDED.
Claude Code prints "esc to interrupt" in the pane footer only while working, so an idle pane = turn
ended. A still-working agent is SLOW, not unheard -> skip without stamping owner_alarmed_at, so the
row alarms the moment its turn ends still-silent. Before this, ALERT_SEC=300 alone nudged marveen
(msg 17934) while he was 20 min into a legitimate task; the sibling owner-ack-guard had the gate and
correctly stayed quiet through the same window. An UNREADABLE pane counts as NOT busy, deliberately:
a dead session holding an unheard owner message is the incident this tool was built for.

Two graduated actions, both gated on that same zero-outbound-since-delivery predicate:
  ALERT   (>= ALERT_SEC silence)   -> wake the agent with a pointed bus nudge (the proven
                                      drift-detector mechanism) + log. Deduped by owner_alarmed_at.
  REDRIVE (>= REDRIVE_SEC silence) -> flip the row delivered->queued (the engine's OWN sanctioned
                                      re-drive path, via requeue()) so the literal owner message is
                                      re-delivered. Capped per row via the shared `requeues` column.
                                      Off unless OWNER_WATCHDOG_REDRIVE=1 (instant kill-switch).

Rollback: stop/disable owner-watchdog.timer (kills everything), or set OWNER_WATCHDOG_REDRIVE=0
to keep alerts but stop auto-re-drive. Pure reader/writer of theoffice.db + the local bus API;
no engine code, no restart.
"""
import argparse, json, os, sqlite3, subprocess, sys, time, urllib.request

DB          = os.environ.get("OWNER_WATCHDOG_DB", "/opt/claude/theoffice/tenant/store/theoffice.db")
TOKEN_FILE  = os.environ.get("OWNER_WATCHDOG_TOKEN", "/opt/claude/theoffice/tenant/store/.dashboard-token")
PORT        = os.environ.get("OFFICE_PORT", "3430")
ALERT_SEC   = int(os.environ.get("OWNER_WATCHDOG_ALERT_SEC",   "300"))   # 5 min silent -> alert
REDRIVE_SEC = int(os.environ.get("OWNER_WATCHDOG_REDRIVE_SEC", "480"))   # 8 min silent -> re-drive
REALARM_SEC = int(os.environ.get("OWNER_WATCHDOG_REALARM_SEC", "600"))   # don't re-alert a row within 10 min
MAX_AGE_SEC = int(os.environ.get("OWNER_WATCHDOG_MAX_AGE_SEC", "7200"))  # never resurrect > 2h-old delivery
MAX_REDRIVES= int(os.environ.get("OWNER_WATCHDOG_MAX_REDRIVES","2"))     # hard cap on auto re-drives per row
REDRIVE_ON  = os.environ.get("OWNER_WATCHDOG_REDRIVE", "0") == "1"
TMUX_SOCKET = os.environ.get("OWNER_WATCHDOG_TMUX_SOCKET", "theoffice")


def db():
    c = sqlite3.connect(DB, timeout=5)
    c.execute("PRAGMA busy_timeout=5000")
    c.row_factory = sqlite3.Row
    return c


def bus(to, content):
    token = open(TOKEN_FILE).read().strip()
    # 'owner-watchdog' is NOT a registered agent: /api/messages accepts any `to` string and returns a
    # success id, so every reply anyone sent to it was silently discarded (22 of them, all status
    # 'delivered', none ever arrived - marveen 16715). The engine's wrap() auto-appends "reply to the
    # sender", so the sender MUST be reachable. A non-LLM timer cannot read a reply anyway; darryl can.
    data = json.dumps({"from": "darryl", "to": to, "content": content}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/messages", data=data,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=10).read().decode()


# The gap-case predicate. A row qualifies when it is an owner channel message, DELIVERED, silent for
# [ALERT_SEC, MAX_AGE_SEC], with ZERO agent outbound at or after its delivery instant.
GAP_SQL = """
SELECT i.id, i.agent_id, i.reply_channel, i.prompt, i.requeues, i.owner_alarmed_at,
       (unixepoch() - i.delivered_at) AS silent_sec
  FROM inbound_queue i
 WHERE i.source='channel'
   AND i.status='delivered'
   AND i.delivered_at IS NOT NULL
   AND (unixepoch() - i.delivered_at) >= ?
   AND (unixepoch() - i.delivered_at) <= ?
   AND NOT EXISTS (
        SELECT 1 FROM outbound_queue o
         WHERE o.agent_id = i.agent_id
           AND o.created_at >= i.delivered_at )
 ORDER BY i.id ASC
"""


def find_gap_rows(conn):
    return conn.execute(GAP_SQL, (ALERT_SEC, MAX_AGE_SEC)).fetchall()


def _pane(agent):
    # READ-ONLY tmux pane text, or None if the session is missing/dead (mirrors owner-ack-guard).
    try:
        r = subprocess.run(["tmux", "-L", TMUX_SOCKET, "capture-pane", "-t", f"agent-{agent}", "-p"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None


def agent_busy(agent):
    # "esc to interrupt" is in the footer ONLY while Claude is working; an idle pane omits it.
    # Can't read the pane (missing/dead session) -> treat as NOT busy so we STILL alarm: a dead
    # session with an unheard owner message is the exact incident this watchdog was built for.
    out = _pane(agent)
    if out is None:
        return False
    return "esc to interrupt" in out


def preview(text, n=90):
    t = " ".join((text or "").split())
    return t[:n] + ("…" if len(t) > n else "")


def run_once(dry=False, verbose=False, check_live=True):
    conn = db()
    rows = find_gap_rows(conn)
    now = int(time.time())
    acted = {"alert": [], "redrive": []}
    for r in rows:
        rid, agent, silent = r["id"], r["agent_id"], r["silent_sec"]
        mins = silent // 60
        # ---- TURN-ENDED GATE (added 2026-09-25 after msg 17934 nudged marveen at ~6m while he was
        # 20 min into a legitimate 9-part task). A still-working agent is SLOW, not unheard. Skip
        # WITHOUT stamping owner_alarmed_at, so the row is re-checked next cycle and alarms the
        # moment the turn ends still-silent -- the threshold stays fast for the real gap.
        # Gates BOTH actions: re-driving a message into a working pane is worse than a nudge.
        if check_live and agent_busy(agent):
            acted["alert"].append((rid, agent, "skip-busy"))
            continue
        # ---- ALERT (deduped by owner_alarmed_at within REALARM_SEC) ----
        last_alarm = r["owner_alarmed_at"]
        due = (last_alarm is None) or (now - last_alarm >= REALARM_SEC)
        if due:
            # NAMES NO HUMAN ON PURPOSE (fixed 2026-09-25). This ran fleet-wide while hardcoding
            # "a duplicate to the owner", but not every agent's human channel is the owner's: clark serves
            # A CONTACT (26 channel rows, each prefixed by the engine with "[Message from a contact - this is
            # NOT your owner (the owner)]") and replies to her with its own say-command, not office-say.
            # So the old text named the wrong person to the one agent most likely to act on it, and
            # called her message an OWNER message. Neutral wording is correct for every agent; the
            # sender's identity is already in the quoted prompt below.
            note = (f"owner-watchdog: a HUMAN-CHANNEL message (inbound {rid}) was delivered to you "
                    f"~{mins}m ago and this check saw no outbound reply from you since. "
                    f"VERIFY BEFORE REPLYING — this check CANNOT see bus sends (agent_messages), only "
                    f"outbound_queue, so an agent working on the bus looks silent. If you have already "
                    f"answered it, DO NOT answer again: a duplicate is worse than a late reply. Answer "
                    f"on the channel THAT MESSAGE came from, using your own say-command. "
                    f"Reply to darryl saying it was already handled.\n> {preview(r['prompt'])}")
            if dry:
                acted["alert"].append((rid, agent, "would-alert"))
            else:
                try:
                    bus(agent, note)
                    conn.execute("UPDATE inbound_queue SET owner_alarmed_at=? WHERE id=?", (now, rid))
                    conn.commit()
                    acted["alert"].append((rid, agent, "alerted"))
                except Exception as e:
                    acted["alert"].append((rid, agent, f"alert-failed:{e}"))
        # ---- REDRIVE (>= REDRIVE_SEC, capped, only if still 'delivered') ----
        if REDRIVE_ON and silent >= REDRIVE_SEC and (r["requeues"] or 0) < MAX_REDRIVES:
            if dry:
                acted["redrive"].append((rid, agent, "would-redrive"))
            else:
                # Guarded flip: only if STILL delivered (not raced to another state); the engine's
                # inbound loop then re-delivers the literal message. requeues+1 shares the cap with orphan.
                changed = conn.execute(
                    "UPDATE inbound_queue SET status='queued', requeues=COALESCE(requeues,0)+1 "
                    "WHERE id=? AND status='delivered'", (rid,)).rowcount
                conn.commit()
                acted["redrive"].append((rid, agent, "redrove" if changed else "skipped-raced"))
    if verbose or dry:
        stamp = time.strftime("%F %T")
        print(f"[{stamp}] gap-rows={len(rows)} redrive_on={REDRIVE_ON} dry={dry}")
        for kind in ("alert", "redrive"):
            for rid, agent, outcome in acted[kind]:
                print(f"  {kind:7} id={rid} agent={agent} -> {outcome}")
    conn.close()
    return acted


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report what WOULD happen; touch nothing")
    ap.add_argument("--verbose", action="store_true", help="print outcomes even when acting")
    ap.add_argument("--no-live", action="store_true",
                    help="skip the turn-ended (pane) gate -- TESTING ONLY; alarms a working agent")
    a = ap.parse_args()
    run_once(dry=a.dry_run, verbose=a.verbose, check_live=not a.no_live)

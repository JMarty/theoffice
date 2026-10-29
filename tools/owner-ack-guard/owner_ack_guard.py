#!/usr/bin/env python3
"""owner-ack-guard (Darryl, 2026-09-13) — FAST front-line catch for the terminal-vs-office-say gap.

Why this exists (the orchestrator, 3 instances in one day): an OWNER Slack message is delivered to an agent,
the agent's turn ENDS, but the agent acked as terminal text / a Bash save and never office-say'd —
so the owner never actually heard back. The existing watchdogs catch this too, but slowly:
  * drift-detector  -> alerts DARRYL at ~240s (I then nudge).
  * owner-watchdog   -> nudges the AGENT at ~300s (+ optional re-drive).
A policy-memory reinforcement hasn't fixed the habit, so this is the MECHANICAL check: nudge the
agent DIRECTLY at ~60-90s (timer every 30s, FAST_SEC=60), tighter than both = the win.

DEDUP (the orchestrator, load-bearing — "one nudge for one gap, never triple"):
  This guard writes the SHARED `inbound_queue.owner_alarmed_at` marker whenever it handles a row.
  - owner-watchdog already dedups on that column (skips a row alarmed within REALARM_SEC) -> auto-superseded.
  - drift-detector skips rows where owner_alarmed_at IS NOT NULL (one-line filter added the same day)
    -> auto-superseded. If THIS guard is off, owner_alarmed_at stays NULL and both fall back to their
    normal cadence, so removing/disabling this guard degrades gracefully to the prior behaviour.
  The natural dedup still does most of the work: once the agent actually office-say's, the outbound
  row makes ALL THREE go quiet. The only gap that needs the explicit marker is a NO-REPLY-NEEDED
  owner message ("ok"/"thanks") — which the slower two would otherwise all nag about.

TURN-ENDED gate (the orchestrator point 1): we only act once the agent's turn has ENDED. Reused from
drift-detector: Claude Code shows "esc to interrupt" in the pane footer ONLY while working, so an
idle pane = turn ended. A still-working agent is slow, not drifted -> skip (and DON'T stamp, so it's
re-checked next cycle and fires the moment its turn ends still-silent).

NO-REPLY-NEEDED handling (the orchestrator point 4): a strict closer classifier ("ok","thanks","got it",…)
downgrades the nudge to a GENTLE single self-nudge (confirm & move on) instead of the urgent one.
Both paths nudge ONCE and stamp owner_alarmed_at, so a misclassification only changes TONE, never
whether the agent is alerted — it can't silently swallow a real gap.

NUDGE THE AGENT, NEVER THE OWNER (the orchestrator point 2): the only side effects are (a) one bus message to
the agent, (b) writing owner_alarmed_at. Read-only on everything else. Never office-says the owner,
never injects a pane, never fabricates.

Scope: default agent = marveen (the reported channel). Broaden via OWNER_ACK_GUARD_AGENTS=a,b,c.
Rollback: stop/disable owner-ack-guard.timer (kills everything); owner_alarmed_at then stays NULL and
the slower watchdogs resume their normal role.
"""
import argparse, json, os, sqlite3, subprocess, time, urllib.request
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
ROOT = os.environ.get("OFFICE_ROOT") or os.path.dirname(TENANT)

DB          = os.environ.get("OWNER_ACK_GUARD_DB", f"{TENANT}/store/theoffice.db")
TOKEN_FILE  = os.environ.get("OWNER_ACK_GUARD_TOKEN", f"{TENANT}/store/.dashboard-token")
PORT        = os.environ.get("OFFICE_PORT", "3430")
FAST_SEC    = int(os.environ.get("OWNER_ACK_GUARD_FAST_SEC", "60"))     # silent this long + turn ended -> nudge
MAX_AGE_SEC = int(os.environ.get("OWNER_ACK_GUARD_MAX_AGE_SEC", "1800")) # never first-nudge a >30m-old delivery
AGENTS      = [a.strip() for a in os.environ.get("OWNER_ACK_GUARD_AGENTS", "marveen").split(",") if a.strip()]
SECRETS     = os.environ.get("OWNER_ACK_GUARD_SLACK_SECRETS", f"{TENANT}/secrets/slack")
TMUX_SOCKET = os.environ.get("OWNER_ACK_GUARD_TMUX_SOCKET", "theoffice")

# Exact-match closers that need no reply -> gentle nudge (tone only). Kept STRICT: a "?" always
# forces the urgent path, and bare "yes"/"no" are deliberately NOT closers (they often need follow-through).
CLOSERS = {
    "ok", "okay", "k", "kk", "thanks", "thank you", "ty", "thx", "cheers", "got it", "gotit",
    "perfect", "great", "cool", "nice", "noted", "sounds good", "sg", "will do", "ok thanks",
    "okay thanks", "ok thank you", "thanks!", "great thanks", "👍", "🙏", "👌", "✅", "🎉",
}


def db():
    c = sqlite3.connect(DB, timeout=5)
    c.execute("PRAGMA busy_timeout=5000")
    c.row_factory = sqlite3.Row
    return c


def bus(to, content):
    token = open(TOKEN_FILE).read().strip()
    data = json.dumps({"from": "owner-ack-guard", "to": to, "content": content}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/messages", data=data,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=10).read().decode()


def _pane(agent):
    # READ-ONLY tmux pane text, or None if the session is missing/dead (mirrors drift-detector).
    try:
        r = subprocess.run(["tmux", "-L", TMUX_SOCKET, "capture-pane", "-t", f"agent-{agent}", "-p"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None


def agent_busy(agent):
    # "esc to interrupt" is in the footer ONLY while Claude is working; idle pane omits it.
    # Can't read the pane (missing/dead session) -> treat as NOT busy so we still nudge the gap.
    out = _pane(agent)
    if out is None:
        return False
    return "esc to interrupt" in out


def slack_replied(agent, channel, since_epoch):
    # Did the agent's bot post to `channel` after delivery via the DIRECT Slack API (bypasses
    # outbound_queue)? Best-effort, mirrors drift-detector: ANY error -> False so a Slack hiccup
    # never SUPPRESSES a real gap (we'd rather nudge-and-let-the-agent-confirm than miss one).
    if not channel:
        return False
    try:
        sec = json.load(open(f"{SECRETS}/{agent}.json"))
        tok = sec.get("botToken"); bot = sec.get("botUserId")
        if not tok:
            return False
        body = json.dumps({"channel": channel, "limit": 20}).encode()
        req = urllib.request.Request("https://slack.com/api/conversations.history", data=body,
                headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        d = json.loads(urllib.request.urlopen(req, timeout=10).read())
        if not d.get("ok"):
            return False
        for m in d.get("messages", []):
            try:
                if float(m.get("ts", 0)) <= since_epoch:
                    continue
            except (TypeError, ValueError):
                continue
            if (bot and m.get("user") == bot) or (not bot and m.get("bot_id")):
                return True
        return False
    except Exception:
        return False


def needs_no_reply(prompt):
    # STRICT closer detector: only clearly-no-reply owner messages downgrade to a gentle nudge.
    # A question always needs an answer. Misclassification is low-stakes (tone only) since both
    # paths nudge once + stamp.
    t = " ".join((prompt or "").split()).strip().lower()
    if not t:
        return True
    if "?" in prompt:
        return False
    return t.rstrip("!.") in CLOSERS or t in CLOSERS


def preview(text, n=90):
    t = " ".join((text or "").split())
    return t[:n] + ("…" if len(t) > n else "")


# Owner channel messages delivered [FAST_SEC, MAX_AGE] ago, NOT yet alarmed by any tool, with ZERO
# agent outbound since delivery. Signal reply_users excluded (mirrors drift-detector's owner-msg predicate).
GAP_SQL = """
SELECT i.id, i.agent_id, i.reply_channel, i.prompt, i.delivered_at,
       (unixepoch() - i.delivered_at) AS silent_sec
  FROM inbound_queue i
 WHERE i.source='channel'
   AND i.status='delivered'
   AND i.delivered_at IS NOT NULL
   AND i.owner_alarmed_at IS NULL
   AND COALESCE(i.reply_user,'') NOT IN ('ocr-signal','bill-signal','archive-signal')
   AND i.agent_id IN ({agents})
   AND (unixepoch() - i.delivered_at) >= ?
   AND (unixepoch() - i.delivered_at) <= ?
   AND NOT EXISTS (
        SELECT 1 FROM outbound_queue o
         WHERE o.agent_id = i.agent_id
           AND o.created_at >= i.delivered_at )
 ORDER BY i.id ASC
"""


def find_gap_rows(conn, agents):
    ph = ",".join("?" for _ in agents)
    sql = GAP_SQL.format(agents=ph)
    return conn.execute(sql, (*agents, FAST_SEC, MAX_AGE_SEC)).fetchall()


def run_once(dry=False, verbose=False, check_live=True):
    conn = db()
    rows = find_gap_rows(conn, AGENTS)
    now = int(time.time())
    acted = []
    for r in rows:
        rid, agent, ch, prompt, silent = r["id"], r["agent_id"], r["reply_channel"], r["prompt"], r["silent_sec"]
        mins = silent // 60
        # TURN-ENDED gate: a still-working agent is slow, not drifted. Skip WITHOUT stamping so it is
        # re-checked next cycle and fires the moment its turn ends still-silent.
        if check_live and agent_busy(agent):
            acted.append((rid, agent, "skip-busy"))
            continue
        # Replied via the direct Slack API (bypasses outbound_queue)? Then it's not a gap. Skip,
        # and DON'T stamp (leave the row to the other tools' own judgement).
        if check_live and slack_replied(agent, ch, r["delivered_at"]):
            acted.append((rid, agent, "skip-slack-replied"))
            continue
        gentle = needs_no_reply(prompt)
        if gentle:
            note = (f"owner-ack-guard: the owner said \"{preview(prompt, 70)}\" ~{silent}s ago and you have "
                    f"office-say'd nothing since. Looks like a closer that may need no reply — just confirm "
                    f"you saw it and move on (no office-say needed if so). Only flagging so it isn't a silent gap.")
        else:
            note = (f"owner-ack-guard: an OWNER message (inbound {rid}) was delivered to you ~{silent}s ago, "
                    f"your turn has ENDED, and you've office-say'd NOTHING since — likely the terminal-vs-"
                    f"office-say gap (acked as terminal text, never sent). Reply now via office-say:\n> {preview(prompt)}")
        if dry:
            acted.append((rid, agent, "would-gentle" if gentle else "would-nudge"))
        else:
            try:
                bus(agent, note)
                # Stamp the SHARED marker -> supersedes owner-watchdog + (via its filter) drift-detector.
                conn.execute("UPDATE inbound_queue SET owner_alarmed_at=? WHERE id=? AND owner_alarmed_at IS NULL",
                             (now, rid))
                conn.commit()
                acted.append((rid, agent, "gentle" if gentle else "nudged"))
            except Exception as e:
                acted.append((rid, agent, f"failed:{e}"))
    if verbose or dry:
        stamp = time.strftime("%F %T")
        print(f"[{stamp}] agents={AGENTS} candidates={len(rows)} fast_sec={FAST_SEC} dry={dry}")
        for rid, agent, outcome in acted:
            print(f"  id={rid} agent={agent} -> {outcome}")
    conn.close()
    return acted


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report what WOULD happen; touch nothing")
    ap.add_argument("--verbose", action="store_true", help="print outcomes even when acting")
    a = ap.parse_args()
    run_once(dry=a.dry_run, verbose=a.verbose)

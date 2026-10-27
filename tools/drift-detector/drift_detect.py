#!/usr/bin/env python3
"""office-say drift detector (DETECT-ONLY).

Catches when an OWNER (Slack channel) message is delivered to an agent but the
agent never office-say's a reply within a window -> alerts darryl to eyeball/nudge.

HARD BOUNDARY (07-02 lesson): read-only on the DB. NEVER injects a pane, never
auto-sends to the owner, never fabricates. Its only side effects are (a) one
inter-agent alert to darryl per drift, (b) its own JSON state file.
"""
import sqlite3, json, os, sys, time, urllib.request, subprocess
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
ROOT = os.environ.get("OFFICE_ROOT") or os.path.dirname(TENANT)

DB   = f"{TENANT}/store/theoffice.db"
TOKEN= f"{TENANT}/store/.dashboard-token"
STATE= f"{TENANT}/store/drift-detector-state.json"
API  = "http://127.0.0.1:3430/api/messages"
WINDOW_S   = 240     # 4 min: delivered longer ago than this with no reply = drift
LOOKBACK_S = 3600    # only consider owner msgs from the last hour

def _pane(agent):
    # READ-ONLY tmux pane text, or None if the session is missing/dead.
    try:
        r = subprocess.run(["tmux","-L","theoffice","capture-pane","-t",f"agent-{agent}","-p"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None

def agent_busy(agent):
    # Claude Code shows "esc to interrupt" in the footer ONLY while working; idle panes omit it.
    # A still-working agent that hasn't office-say'd yet is NOT drift, just slow.
    out = _pane(agent)
    if out is None:
        return False  # can't read pane (missing/dead session) -> not busy, so we still alert
    return "esc to interrupt" in out

def agent_alive(agent):
    # Session exists at all (idle or busy)? Distinguishes "unreachable/held" from "not running".
    return _pane(agent) is not None

SECRETS = f"{TENANT}/secrets/slack"

def slack_replied(agent, channel, since_epoch):
    # Did the agent's bot post to `channel` AFTER since_epoch? Catches replies sent via the DIRECT
    # Slack API (chat.postMessage) that never touch the outbound_queue -- e.g. PROACTIVE outreach,
    # which office-say cannot do (office-say only replies to whoever last messaged the agent).
    # Lesson: an agent greeted the owner via chat.postMessage; outbound_queue was empty so the
    # detector false-fired. Best-effort: on ANY error return False so a Slack hiccup never SUPPRESSES
    # a real drift (we'd rather alert-and-verify than silently miss one).
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
            # a message from THIS agent's bot after the owner msg = it replied (direct-API path)
            if (bot and m.get("user") == bot) or (not bot and m.get("bot_id")):
                return True
        return False
    except Exception:
        return False

def detect(now, conn, check_busy=True):
    cur = conn.cursor()
    # owner channel messages delivered, older than the window, within lookback
    rows = cur.execute("""
        SELECT id, agent_id, delivered_at, reply_channel, substr(replace(prompt,char(10),' '),1,60)
        FROM inbound_queue
        WHERE source='channel' AND delivered_at IS NOT NULL
          AND owner_alarmed_at IS NULL
          AND COALESCE(reply_user,'') NOT IN ('ocr-signal','bill-signal','archive-signal')
          AND delivered_at <= ? AND delivered_at >= ?
        ORDER BY id
    """, (now - WINDOW_S, now - LOOKBACK_S)).fetchall()
    drifts = []
    for iid, agent, delivered, reply_channel, snippet in rows:
        # answered = any office-say (outbound) from this agent created after delivery
        # and at/before the evaluation time (created_at<=now keeps --now replays faithful)
        n = cur.execute("""SELECT COUNT(*) FROM outbound_queue
                           WHERE agent_id=? AND created_at >= ? AND created_at <= ?""",
                        (agent, delivered, now)).fetchone()[0]
        if n == 0:
            # outbound_queue is empty BUT the agent may have replied via the DIRECT Slack API
            # (bypasses the queue -- see slack_replied). Verify against Slack before flagging.
            # Live only: skip the Slack check on --now replay (check_busy=False) to keep replays pure.
            if check_busy and slack_replied(agent, reply_channel, delivered):
                continue
            busy = agent_busy(agent) if check_busy else False
            drifts.append({"inbound": iid, "agent": agent, "busy": busy,
                           "delivered_at": delivered, "snippet": snippet,
                           "silent_min": round((now - delivered)/60, 1)})
    return drifts

def detect_undelivered(now, conn):
    # SECOND CLASS of drift (07-10 lesson): an OWNER channel message that never
    # got DELIVERED at all -- it sits status='queued', delivered_at NULL. Root cause
    # seen in the wild: the agent tied up its session with a long-running (multi-hour)
    # shell, so the dispatcher held every new owner message as busy. The delivered-path
    # detector above is blind to this (it requires delivered_at IS NOT NULL). Here we
    # flag channel messages queued+undelivered longer than the window while the agent's
    # session is still alive (so it's a hold/unreachable, not simply an offline agent).
    # Exclude the detector's own agent (darryl): a self-alert can't be acted on while darryl is
    # busy, and darryl legitimately runs long polling shells -> would be pure self-noise.
    cur = conn.cursor()
    rows = cur.execute("""
        SELECT id, agent_id, created_at, substr(replace(prompt,char(10),' '),1,60)
        FROM inbound_queue
        WHERE source='channel' AND delivered_at IS NULL AND status='queued'
          AND agent_id != 'darryl'
          AND COALESCE(reply_user,'') NOT IN ('ocr-signal','bill-signal','archive-signal')
          AND created_at <= ? AND created_at >= ?
        ORDER BY id
    """, (now - WINDOW_S, now - LOOKBACK_S)).fetchall()
    stuck = []
    for iid, agent, created, snippet in rows:
        # Only flag IDLE-but-undelivered agents. A BUSY agent (esc-to-interrupt in pane) is mid-turn:
        # the message is either in-flight (delivered to the session, delivered_at not yet written) or
        # queued behind the current turn and will land when it ends -> NOT stuck. 2026-07-11 lesson:
        # marveen was actively composing a REPLY to the owner msg while the DB still showed it queued.
        # The real rot case (Dwight's multi-hour bg shell) has an IDLE pane, so it still fires here.
        if agent_alive(agent) and not agent_busy(agent):
            stuck.append({"inbound": iid, "agent": agent, "created_at": created,
                          "snippet": snippet, "stuck_min": round((now - created)/60, 1)})
    return stuck

def alert_undelivered(d):
    tok = open(TOKEN).read().strip()
    msg = (f"UNDELIVERED: an OWNER Slack message to {d['agent']} (inbound {d['inbound']}: "
           f"\"{d['snippet']}\") has sat QUEUED/undelivered for {d['stuck_min']} min -- it never "
           f"reached the agent. Likely a long-running shell holding the session busy so the "
           f"dispatcher can't deliver. Eyeball {d['agent']}: if it's tied up on a multi-hour job, "
           f"the owner is being ignored without either side knowing. Detect-only alert.")
    body = json.dumps({"from":"drift-detector","to":"darryl","content":msg}).encode()
    req = urllib.request.Request(API, data=body,
            headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"})
    urllib.request.urlopen(req, timeout=10)

def load_state():
    try:
        s = json.load(open(STATE))
    except Exception:
        s = {}
    s.setdefault("alerted", [])            # delivered-path (office-say drift) inbound ids
    s.setdefault("alerted_undelivered", [])  # undelivered-path inbound ids
    return s

def save_state(s): json.dump(s, open(STATE, "w"))

def alert(d):
    tok = open(TOKEN).read().strip()
    msg = (f"DRIFT: {d['agent']} received an OWNER Slack message (inbound {d['inbound']}: "
           f"\"{d['snippet']}\") {d['silent_min']} min ago and has NOT office-say'd any reply. "
           f"Eyeball the agent + nudge if it drifted (office-say drift). Detect-only alert.")
    body = json.dumps({"from":"drift-detector","to":"darryl","content":msg}).encode()
    req = urllib.request.Request(API, data=body,
            headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"})
    urllib.request.urlopen(req, timeout=10)

def main():
    dry = "--dry-run" in sys.argv
    now = int(time.time())
    replay = False
    for a in sys.argv:
        if a.startswith("--now="): now = int(a.split("=",1)[1]); replay = True
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    # skip the live pane busy-check when replaying a historical --now (pane is "now", not then)
    drifts = detect(now, conn, check_busy=not replay)
    # undelivered path uses the live session-alive check; skip on historical replay
    stuck = [] if replay else detect_undelivered(now, conn)
    st = load_state()
    alerted = set(st["alerted"]); alerted_u = set(st["alerted_undelivered"])
    # ALERT only idle+silent agents. A BUSY agent is still working (not drift) -> skip it
    # AND do NOT mark it alerted, so it is re-checked next cycle: if it later finishes
    # without office-say'ing, it goes idle+silent and WILL alert then.
    fresh = [d for d in drifts if not d["busy"] and d["inbound"] not in alerted]
    working = [d for d in drifts if d["busy"]]
    fresh_u = [d for d in stuck if d["inbound"] not in alerted_u]
    out = {"ok": True, "now": now, "drifts": len(drifts),
           "fresh": len(fresh), "working_skipped": len(working),
           "undelivered": len(stuck), "fresh_undelivered": len(fresh_u),
           "detail": drifts, "detail_undelivered": stuck}
    print(json.dumps(out, indent=1))
    if dry: return
    for d in fresh:
        alert(d); alerted.add(d["inbound"])
    for d in fresh_u:
        alert_undelivered(d); alerted_u.add(d["inbound"])
    st["alerted"] = sorted(alerted)[-500:]
    st["alerted_undelivered"] = sorted(alerted_u)[-500:]
    save_state(st)

if __name__ == "__main__":
    main()

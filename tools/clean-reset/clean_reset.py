#!/usr/bin/env python3
"""Clean-reset orchestrator (dashboard 'Handoff + Reset' button).

Sequence for one agent: (1) tell it to write HANDOFF.md, (2) wait for the file,
(3) restart it via the engine API (fresh context; it re-reads HANDOFF on boot per
its CLAUDE.md), (4) tell it to read the handoff + office-say the owner a summary.

Runs in the background (spawned fire-and-forget by the web action). Logs to
clean-reset.log. Uses tmux send-keys for instructions (immediate, idle-aware).
"""
import sys, time, subprocess, os, urllib.request, datetime

AGENT = sys.argv[1] if len(sys.argv) > 1 else ""
SOCK = "theoffice"
SESSION = f"agent-{AGENT}"
HANDOFF = f"/opt/claude/theoffice/tenant/agents/{AGENT}/HANDOFF.md"
TOKEN = open("/opt/claude/theoffice/tenant/store/.dashboard-token").read().strip()
LOG = "/opt/claude/theoffice/tenant/store/clean-reset.log"

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{datetime.datetime.now():%H:%M:%S} [{AGENT}] {msg}\n")

def pane():
    try:
        return subprocess.run(["tmux","-L",SOCK,"capture-pane","-t",SESSION,"-p"],
                              capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""

def idle():
    return "esc to interrupt" not in pane()

def send(text):
    subprocess.run(["tmux","-L",SOCK,"send-keys","-t",SESSION,text], timeout=5)
    time.sleep(0.8)
    subprocess.run(["tmux","-L",SOCK,"send-keys","-t",SESSION,"Enter"], timeout=5)

def wait_idle(timeout=180):
    for _ in range(timeout // 3):
        if idle(): return True
        time.sleep(3)
    return False

def main():
    if not AGENT:
        log("no agent arg"); return
    log("clean-reset START")
    # 1) write handoff
    wait_idle(90)
    send("CLEAN RESET (the owner triggered this from the dashboard): FIRST, write your HANDOFF.md right now using the handoff skill — capture current state, open tasks, pending decisions, in-flight work. This is a routine context refresh: right after you save it I restart you with a fresh context and you re-read the handoff. Just write the handoff now, nothing else.")
    log("sent handoff instruction")
    # 2) wait for HANDOFF.md to be (re)written + agent idle
    before = os.path.getmtime(HANDOFF) if os.path.exists(HANDOFF) else 0
    wrote = False
    for _ in range(120):  # up to ~6 min
        time.sleep(3)
        if os.path.exists(HANDOFF) and os.path.getmtime(HANDOFF) > before and idle():
            wrote = True; break
    log(f"handoff written={wrote}")
    # 3) restart via engine API (fresh context; CLAUDE.md makes it re-read HANDOFF on boot)
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:3430/api/agents/{AGENT}/restart", data=b"",
            headers={"Authorization":"Bearer "+TOKEN}, method="POST"), timeout=20)
        log("restart POSTed")
    except Exception as e:
        log(f"restart FAILED: {e}"); return
    # 4) wait for the session back + at a ready prompt
    time.sleep(20)
    ready = False
    for _ in range(50):  # up to ~2.5 min
        p = pane()
        if p and "esc to interrupt" not in p and ("bypass permissions" in p or "❯" in p):
            ready = True; break
        time.sleep(3)
    log(f"back ready={ready}")
    # 5) summary instruction (agent reads HANDOFF per CLAUDE.md, then office-says the owner)
    time.sleep(2)
    if os.environ.get("NO_SUMMARY") == "1":   # fleet maintenance restart (model bump): recover context quietly, nobody is messaged
        send("You were just cleanly restarted (fleet model update). Read your HANDOFF.md to recover context and carry on. Do NOT office-say anyone and do NOT message the owner about this restart; resume your work silently.")
        log("sent QUIET recover instruction (no summary) — DONE"); return
    send("You were just cleanly restarted with a fresh context (the owner triggered a Handoff + Reset from the dashboard). Read your HANDOFF.md to recover context, then office-say the owner a short 3-5 line summary of where everything stands + any open items. Keep it tight.")
    log("sent summary instruction — DONE")

if __name__ == "__main__":
    main()

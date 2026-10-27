#!/usr/bin/env python3
"""Auto-compact context watchdog.

Reads each agent's Claude Code pane footer for the context-usage %. When an
agent crosses a HIGH threshold AND is idle, it sends /compact to that agent's
tmux pane BEFORE the context bloat degrades it into office-say drift.

/compact is SAFE + session-preserving (summarizes context, keeps the session +
reply channel). This is the preventive counterpart to the drift-detector:
drift-detector catches the SYMPTOM (already drifted); this prevents the CAUSE.
"""
import subprocess, re, json, os, sys, time, glob, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from occupancy import read_transcript
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
ROOT = os.environ.get("OFFICE_ROOT") or os.path.dirname(TENANT)

AGENTS = ["marveen","cfo","dwight","toby","pam","jim","pete","ryan"]  # not darryl (self)
THRESHOLD = 85          # compact when context used >= this %
COOLDOWN_S = 6 * 3600   # at most ONE compact per agent per 6h (a dry-run 'would' counts too, so the dry-run shows the real rate)
HERE = os.path.dirname(os.path.abspath(__file__))
IDLE_MIN_S = 900        # idle means: no 'esc to interrupt' AND the transcript has not been written for 15 min
# BLIND DETECTION (2026-09-26). ctx_pct() returns None when it cannot find a percentage, and this file
# used to comment that as "not shown = low context" -- i.e. UNPARSEABLE was read as HEALTHY. The run then
# printed {"ok": true} with pct:null for every agent and looked fine. Measured that morning: null for all
# 8 agents, no pane showing any context text, and no compaction anywhere since 09-13 -- while marveen's
# own transcript held 12 auto compact_boundary records (9 of them AFTER that date, 4 the same day) at
# preTokens ~968-970k. So it was BLIND, not quiet: agents sail to ~97% and native auto-compact catches
# them. Nothing is dying; what is lost is EARLY, clean compaction.
# This block makes the blindness LOUD. It deliberately does NOT change `act` -- see the ACT-path note in
# main(). Dwell is measured in TIME, not consecutive runs: a run counter under-counts whenever the timer
# is paused, re-timed or the box is busy, and wall-clock stays honest through all of it.
BLIND_DWELL_S = int(os.environ.get("CTX_BLIND_DWELL_S", "3600"))   # say nothing for this long, then say it once
BLIND_REALERT_S = int(os.environ.get("CTX_BLIND_REALERT_S", "86400"))  # then at most once a day
STATE = f"{TENANT}/store/context-watchdog-state.json"
TOKEN = f"{TENANT}/store/.dashboard-token"
API   = "http://127.0.0.1:3430/api/messages"

def pane(agent):
    try:
        return subprocess.run(["tmux","-L","theoffice","capture-pane","-t",f"agent-{agent}","-p"],
                              capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""

def ctx_pct(txt):
    # Claude Code footer shows "N% context used" near the limit (used = high=bad).
    m = re.search(r"(\d+)%\s*context\s*used", txt, re.I)
    if m: return int(m.group(1))
    # defensive: some builds show "context left: N%" (remaining) -> convert
    m = re.search(r"context\s*left[:\s]*?(\d+)%", txt, re.I) or re.search(r"(\d+)%\s*context\s*left", txt, re.I)
    if m: return 100 - int(m.group(1))
    return None  # not shown = low context

# JSONL MEASUREMENT (2026-10-22). occupancy = max(cache_read + cache_creation) after the newest metadata-bearing
# compact_boundary; ceiling = that boundary's preTokens (what native auto-compact actually fires at). Immune to footer wording.
# ACTING on it is OFF unless CTX_ACT_JSONL=1: until the dry-run matrix is reviewed it only feeds `readable`/blind
# detection and a `would_compact` column, so a mis-measure cannot compact anyone.
ACT_JSONL = os.environ.get("CTX_ACT_JSONL") == "1"
DEFAULT_CEILING = int(os.environ.get("CTX_DEFAULT_CEILING", "950000"))   # used only before an agent has ever auto-compacted
PROJECTS = os.path.expanduser("~/.claude/projects")

def transcript_pct(agent):
    """-> {"pct","occ","ceiling","file_age_s"} or None (could not measure; NEVER read as healthy)."""
    try:
        cwd = subprocess.run(["tmux","-L","theoffice","display-message","-p","-t",f"agent-{agent}","#{pane_current_path}"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        if not cwd: return None
        files = glob.glob(os.path.join(PROJECTS, cwd.replace("/", "-"), "*.jsonl"))
        if not files: return None
        newest = max(files, key=os.path.getmtime)
        occ, ceiling, _ = read_transcript(newest)
        if occ is None: return None
        ceil = ceiling or DEFAULT_CEILING
        return {"pct": round(100 * occ / ceil), "occ": occ, "ceiling": ceil, "ceiling_known": bool(ceiling),
                "file_age_s": int(time.time() - os.path.getmtime(newest))}
    except Exception:
        return None

def is_idle(txt):
    # actively processing shows "esc to interrupt"; idle omits it
    return "esc to interrupt" not in txt

def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"last_compact": {}}

def save_state(s): json.dump(s, open(STATE,"w"))

def bus(msg):
    # `from` is darryl, NOT "context-watchdog": the engine appends "reply to the sender", and a
    # non-registered sender silently discards every reply (the defect owner-watchdog already fixed).
    try:
        tok = open(TOKEN).read().strip()
        body = json.dumps({"from":"darryl","to":"darryl","content":msg}).encode()
        urllib.request.urlopen(urllib.request.Request(API, data=body,
            headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"}), timeout=10)
        return True
    except Exception:
        return False


def alert(agent, pct):
    try:
        tok = open(TOKEN).read().strip()
        msg = (f"AUTO-COMPACT: {agent} hit {pct}% context (>= {THRESHOLD}%) while idle — "
               f"sent /compact to keep it from drifting. Preventive, safe (session-preserving). No action needed.")
        body = json.dumps({"from":"context-watchdog","to":"darryl","content":msg}).encode()
        urllib.request.urlopen(urllib.request.Request(API, data=body,
            headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"}), timeout=10)
        # one short line to marveen per real compact
        body = json.dumps({"from":"darryl","to":"marveen","content":f"CTX-COMPACT {agent} {pct}% (idle, gate ok)"}).encode()
        urllib.request.urlopen(urllib.request.Request(API, data=body,
            headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"}), timeout=10)
    except Exception: pass

def compact(agent):
    # send /compact then Enter (typing replaces any ghost/placeholder text)
    subprocess.run(["tmux","-L","theoffice","send-keys","-t",f"agent-{agent}","/compact"], timeout=5)
    time.sleep(0.6)
    subprocess.run(["tmux","-L","theoffice","send-keys","-t",f"agent-{agent}","Enter"], timeout=5)

def main():
    dry = "--dry-run" in sys.argv
    now = int(time.time())
    st = load_state(); last = st.get("last_compact", {})
    results = []
    for a in AGENTS:
        txt = pane(a)
        if not txt: continue
        pane_pct = ctx_pct(txt); idle = is_idle(txt)
        tr = transcript_pct(a)
        pct = pane_pct if pane_pct is not None else (tr["pct"] if tr else None)
        src = "pane" if pane_pct is not None else ("jsonl" if tr else None)
        wl = st.setdefault("would_last", {})
        cooled = (now - max(last.get(a, 0), wl.get(a, 0))) >= COOLDOWN_S
        quiet = tr is None or tr["file_age_s"] >= IDLE_MIN_S
        idle = idle and quiet
        # ACT PATH DELIBERATELY UNCHANGED (2026-09-26). A None still cannot act, so everything below is
        # observability only and carries ZERO risk of compacting a healthy agent. Re-sourcing the
        # measurement (jsonl `usage.cache_read_input_tokens + cache_creation_input_tokens` for occupancy
        # against `compactMetadata.preTokens` for the ceiling -- immune to CLI footer wording, and NOT
        # total_tokens_reminder, which is session budget) plus a retuned threshold is the OTHER half of
        # this fix, and it is where a mis-parse compacts someone mid-task. That half needs a negative
        # control and a dry-run matrix first. Make it ADMIT it cannot see now; make it SEE when ready.
        may_act = src == "pane" or (src == "jsonl" and ACT_JSONL)
        act = (pct is not None and pct >= THRESHOLD and idle and cooled and may_act)
        would = (pct is not None and pct >= THRESHOLD and idle and cooled)
        results.append({"agent":a,"pct":pct,"src":src,"idle":idle,"cooled":cooled,"compact":act,"would_compact":would,
                        **({"occ":tr["occ"],"ceiling":tr["ceiling"],"ceiling_known":tr["ceiling_known"],"file_age_s":tr["file_age_s"]} if tr else {})})
        if would: wl[a] = now      # first would-compact starts the 6h window, so repeats are not counted
        if act and not dry:
            # last-second re-check (kill switch file + the pane is idle RIGHT NOW + transcript still quiet): a compact must never land on a working agent
            tr2 = transcript_pct(a); txt2 = pane(a)
            if os.path.exists(os.path.join(HERE, "ACT-DISABLED")) or not txt2 or not is_idle(txt2) or (tr2 and tr2["file_age_s"] < IDLE_MIN_S):
                results[-1]["compact"] = False; results[-1]["skipped"] = "recheck: not idle / disabled"
            else:
                compact(a); last[a] = now; alert(a, pct)
    st["last_compact"] = last

    # ---- BLIND STATE: "I could not read it" is its own outcome, never "healthy" ----
    seen = [r for r in results if r["pct"] is not None]
    blind = bool(results) and not seen
    status = "ok" if seen else ("blind" if results else "no-panes")
    since = st.get("blind_since")
    note = None
    if blind:
        if not since:
            since = now
        blind_for = now - since
        last_alert = st.get("blind_alerted_at", 0)
        due = blind_for >= BLIND_DWELL_S and (now - last_alert) >= BLIND_REALERT_S
        if due:
            n = int(st.get("blind_alert_count", 0)) + 1
            note = (f"CONTEXT-WATCHDOG IS BLIND, NOT QUIET [{n}] -- it has been unable to read a context "
                    f"percentage for any of {len(results)} agents for {blind_for//3600}h. Unparseable is NOT "
                    f"healthy: while this lasts NO agent is being compacted early, and they run to the "
                    f"native auto-compact ceiling (~97%) instead. This is a QUALITY loss, not an outage. "
                    f"Fix is carded: re-source the measurement from the session jsonl, not the pane footer.")
            if not dry and bus(note):
                st["blind_alerted_at"] = now; st["blind_alert_count"] = n
        st["blind_since"] = since
    else:
        # cleared on the RESTORE, not on the alert: otherwise a blind/seeing/blind flap inherits the old
        # timestamp and the dwell fires instantly the second time.
        for k in ("blind_since","blind_alerted_at","blind_alert_count"):
            st.pop(k, None)

    if not dry: save_state(st)
    out = {"ok": not blind, "status": status, "threshold": THRESHOLD,
           "readable": f"{len(seen)}/{len(results)}", "results": results}
    if blind:
        out["blind_for_sec"] = now - since
        out["blind_note"] = note or "within dwell; not yet alerted"
    print(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()

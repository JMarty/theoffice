#!/usr/bin/env python3
"""agent-state trial: derive an agent's state from Claude Code lifecycle hook events and compare it with the pane-state detector.

OBSERVE-ONLY. Nothing consumes this yet; the point is to measure how often the hook-derived state and pane-state agree before anyone relies on it.
Events come from agent-state-hook.sh (store/agent-state/<agent>.events.log), pane samples from pane_sampler.mjs (<agent>.pane.log).

  agent_state.py show [AGENT]                  current state, since, bounded history (JSON)
  agent_state.py compare [AGENT] [--hours N]   agreement rate of hook state vs pane state
"""
import argparse
import json
import os
import sys
import time

TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
DIR = os.environ.get("AGENT_STATE_DIR") or os.path.join(TENANT, "store", "agent-state")
TOLERANCE_MS = 5000   # a sample this close to a hook transition is a race between two observers, not a disagreement

# hook state -> the pane states it agrees with. A permission prompt keeps the turn open: the pane is either the modal (unknown, reported apart) or busy.
AGREES = {"working": {"busy"}, "idle": {"idle", "typing"}, "awaiting_approval": {"busy"}, "ended": set()}


def parse_events(text):
    out = []
    for line in text.splitlines():
        p = line.split("\t")
        if len(p) < 2 or not p[0].isdigit():
            continue
        out.append({"ts": int(p[0]), "event": p[1], "extra": p[2] if len(p) > 2 else ""})
    return out


def parse_samples(text):
    out = []
    for line in text.splitlines():
        p = line.split("\t")
        if len(p) == 2 and p[0].isdigit():
            out.append({"ts": int(p[0]), "state": p[1]})
    return out


def _next_state(event, extra, cur):
    if event == "SessionStart":
        return "idle"
    if event in ("UserPromptSubmit", "PreToolUse", "PostToolUse"):
        return "working"
    if event == "Notification":
        return "awaiting_approval" if extra == "perm" else ("idle" if extra == "idle" else cur)
    if event == "Stop":
        return "idle"
    if event == "SessionEnd":
        return "ended"
    return cur


def timeline(events):
    """-> [{"from_ms", "state"}] with consecutive identical states collapsed."""
    tl, cur = [], None
    for e in sorted(events, key=lambda x: x["ts"]):
        nxt = _next_state(e["event"], e["extra"], cur)
        if nxt is not None and nxt != cur:
            tl.append({"from_ms": e["ts"], "state": nxt})
            cur = nxt
    return tl


def state_at(tl, ts):
    cur = None
    for s in tl:
        if s["from_ms"] <= ts:
            cur = s["state"]
        else:
            break
    return cur


def show(events, now_ms):
    tl = timeline(events)
    last = tl[-1] if tl else None
    prev = None
    hist = []
    for s in tl[-50:]:
        hist.append({"ts": s["from_ms"], "from": prev, "to": s["state"]})
        prev = s["state"]
    return {"state": last["state"] if last else None, "since": last["from_ms"] if last else None,
            "updated_at": max((e["ts"] for e in events), default=None), "observed_for_ms": (now_ms - tl[0]["from_ms"]) if tl else 0, "history": hist}


def compare(tl, samples, tolerance_ms=TOLERANCE_MS):
    transitions = [s["from_ms"] for s in tl]
    res = {"compared": 0, "agree": 0, "skipped_near_transition": 0, "pane_unknown": 0, "disagree": []}
    mism = {}
    for p in samples:
        h = state_at(tl, p["ts"])
        if h is None:
            continue
        if any(abs(p["ts"] - t) <= tolerance_ms for t in transitions):
            res["skipped_near_transition"] += 1
            continue
        if p["state"] in ("unknown", "error"):
            res["pane_unknown"] += 1
            continue
        res["compared"] += 1
        if p["state"] in AGREES.get(h, set()):
            res["agree"] += 1
        else:
            mism[(h, p["state"])] = mism.get((h, p["state"]), 0) + 1
    res["disagree"] = [{"hook": h, "pane": ps, "n": n} for (h, ps), n in sorted(mism.items(), key=lambda kv: -kv[1])]
    res["agreement"] = (res["agree"] / res["compared"]) if res["compared"] else None
    return res


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show"); s.add_argument("agent", nargs="?", default="darryl")
    c = sub.add_parser("compare"); c.add_argument("agent", nargs="?", default="darryl"); c.add_argument("--hours", type=float, default=24)
    a = ap.parse_args(argv)
    ev_path, pane_path = os.path.join(DIR, f"{a.agent}.events.log"), os.path.join(DIR, f"{a.agent}.pane.log")
    events = parse_events(open(ev_path).read()) if os.path.exists(ev_path) else []
    now = int(time.time() * 1000)
    if a.cmd == "show":
        print(json.dumps(show(events, now), indent=1))
        return 0
    cut = now - int(a.hours * 3600_000)
    samples = [x for x in (parse_samples(open(pane_path).read()) if os.path.exists(pane_path) else []) if x["ts"] >= cut]
    tl = timeline([e for e in events if e["ts"] >= cut - 3600_000])  # one hour of lead-in so the first samples have a state
    r = compare(tl, samples)
    r["window_hours"] = a.hours
    r["events"] = len(events)
    r["samples"] = len(samples)
    print(json.dumps(r, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Rolling fleet clean-reset: restart every agent ONE AT A TIME through clean_reset.py (handoff written first, fresh context, quiet recovery:
NO_SUMMARY=1, nobody is messaged), so a fleet-wide change that only loads at session start (Claude Code hooks, settings) takes effect without everyone
going dark at once. Waits for each agent's reset to finish and its session to be back before starting the next, and carries on past a failed one.

  rolling_reset.py [--last AGENT ...] [--only A,B,C] [--gap SECONDS] [--dry-run]

Default roster: every agent-* tmux session. --last agents go to the end, in the order given (the main agent last, the one running this tool just before it).
Run it detached (systemd-run) when it is started from an agent session that will itself be reset. Log: <tenant>/store/rolling-reset.log.
"""
import argparse
import datetime
import os
import subprocess
import sys
import time

TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
HERE = os.path.dirname(os.path.abspath(__file__))
SOCK = "theoffice"


def order(roster, last):
    """roster minus the `last` agents, then the `last` agents in the order given (only those that exist)."""
    tail = [a for a in last if a in roster]
    return [a for a in sorted(roster) if a not in tail] + tail


def live_roster():
    out = subprocess.run(["tmux", "-L", SOCK, "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True, timeout=10).stdout
    return [s[len("agent-"):] for s in out.split() if s.startswith("agent-")]


def session_up(agent):
    return subprocess.run(["tmux", "-L", SOCK, "has-session", "-t", f"agent-{agent}"], capture_output=True, timeout=10).returncode == 0


def frozen():
    """A fleet freeze is on: a reset would restart agents the owner just froze, and a frozen agent cannot write its handoff. Abort instead."""
    return os.path.exists(os.path.join(TENANT, "store", "fleet-freeze.json"))


def log(msg):
    line = f"{datetime.datetime.now():%F %T} {msg}"
    print(line, flush=True)
    try:
        with open(os.path.join(TENANT, "store", "rolling-reset.log"), "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--last", nargs="*", default=[])
    ap.add_argument("--only", default="")
    ap.add_argument("--gap", type=int, default=60)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    roster = [x for x in a.only.split(",") if x] if a.only else live_roster()
    seq = order(roster, a.last)
    log(f"rolling reset plan: {' -> '.join(seq)}")
    if a.dry_run:
        return 0
    if frozen():
        log("ABORT: the fleet is frozen (store/fleet-freeze.json exists); nothing was reset")
        return 3
    env = {**os.environ, "NO_SUMMARY": "1", "OFFICE_TENANT_ROOT": TENANT}
    for n, agent in enumerate(seq, 1):
        if frozen():
            log(f"ABORT before {agent}: the fleet was frozen during the run; the remaining agents were not reset")
            return 3
        log(f"[{n}/{len(seq)}] {agent}: clean reset start")
        t0 = time.time()
        r = subprocess.run([sys.executable, os.path.join(HERE, "clean_reset.py"), agent], env=env)
        up = session_up(agent)
        log(f"[{n}/{len(seq)}] {agent}: finished rc={r.returncode} session_up={up} in {int(time.time() - t0)}s")
        if n < len(seq):
            time.sleep(a.gap)
    log("rolling reset DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""disk-watch: model-free free-space watcher for the volume the office runs on.

A full disk stops the whole fleet at once (no bus, no transcripts, no sends), usually with no warning.
This runs from a systemd timer (no LLM), measures free space the way `df` does (statvfs f_bavail, never du)
and tells the owner's relay agent over the bus when it gets low. It NEVER deletes anything.

Levels: ok, warn (free below 25% of the volume by default), crit (below 12%). DISK_WARN_GB / DISK_CRIT_GB set an absolute
free-GB threshold instead (each independently). Hysteresis, so it never
alerts every run:
  - an alert goes out when the level gets worse (ok -> warn, ok/warn -> crit);
  - while crit it repeats at most every CRIT_REPEAT_S (60 min);
  - it returns to ok only above warn + 20% of warn, with one "back to normal" message.
A failed send does not advance the state, so the alert is retried on the next run.

Exit code: 0 whenever it measured (an alert is not a failure); 1 when it could not measure or save state.

Env: DISK_WATCH_PATH (volume to watch, default the tenant root), DISK_WATCH_ALERT_TO (bus agent that relays
to the owner, default marveen), DISK_WARN_PCT, DISK_CRIT_PCT, DISK_WARN_GB, DISK_CRIT_GB, OFFICE_TENANT_ROOT, OFFICE_PORT.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

GB = 1024 ** 3
CRIT_REPEAT_S = 3600
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
PORT = os.environ.get("OFFICE_PORT", "3430")
ALERT_TO = os.environ.get("DISK_WATCH_ALERT_TO", "marveen")
RANK = {"ok": 0, "warn": 1, "crit": 2}


def level_of(free_gb, warn_gb, crit_gb):
    if free_gb < crit_gb:
        return "crit"
    if free_gb < warn_gb:
        return "warn"
    return "ok"


def decide(prev, free_gb, now, warn_gb, crit_gb):
    """-> (new_state, message kind or None). Pure. prev = {"level", "alerted_at"}; kind = warn | crit | recovered."""
    prev_level = prev.get("level") if prev.get("level") in RANK else "ok"
    alerted_at = prev.get("alerted_at") if isinstance(prev.get("alerted_at"), (int, float)) else 0
    raw = level_of(free_gb, warn_gb, crit_gb)
    if RANK[raw] > RANK[prev_level]:
        return {"level": raw, "alerted_at": now}, raw
    if raw == "crit":
        if now - alerted_at >= CRIT_REPEAT_S:
            return {"level": "crit", "alerted_at": now}, "crit"
        return {"level": "crit", "alerted_at": alerted_at}, None
    if prev_level != "ok" and free_gb >= warn_gb * 1.2:
        return {"level": "ok", "alerted_at": now}, "recovered"
    return {"level": prev_level, "alerted_at": alerted_at}, None  # better but inside the margin: keep the worse level, stay quiet


def thresholds(total_gb, env):
    """-> (warn_gb, crit_gb). Percent of the volume by default (warn 25%, crit 12%); DISK_WARN_GB / DISK_CRIT_GB override each with an absolute value."""
    warn = float(env["DISK_WARN_GB"]) if env.get("DISK_WARN_GB") else total_gb * float(env.get("DISK_WARN_PCT", "25")) / 100
    crit = float(env["DISK_CRIT_GB"]) if env.get("DISK_CRIT_GB") else total_gb * float(env.get("DISK_CRIT_PCT", "12")) / 100
    return warn, min(crit, warn)


def message(kind, free_gb, total_gb, warn_gb, crit_gb, path):
    if kind == "recovered":
        return "[disk-watch] Disk free space is back to normal: %.0f GB free of %.0f GB on %s." % (free_gb, total_gb, path)
    if kind == "crit":
        head = "[disk-watch] CRITICAL: %.1f GB free on %s (threshold %.0f GB). If it runs out the whole fleet stops." % (free_gb, path, crit_gb)
    else:
        head = "[disk-watch] Warning: %.0f GB free on %s (threshold %.0f GB)." % (free_gb, path, warn_gb)
    return head + " Nothing was deleted; find what grew (du -sh on the biggest directories) and decide what to clear."


def save_state(path, state):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".disk-watch-")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def bus_post(to, text):
    """True if the bus accepted it. 'disk-watch' is not a routable agent, so the sender is darryl (replies reach an agent that can read them)."""
    try:
        token = open(os.path.join(TENANT, "store", ".dashboard-token")).read().strip()
        data = json.dumps({"from": "darryl", "to": to, "content": text}).encode()
        req = urllib.request.Request("http://127.0.0.1:%s/api/messages" % PORT, data=data, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200
    except (OSError, ValueError):
        return False


def main(argv=None, poster=bus_post, now=None, env=os.environ):
    ap = argparse.ArgumentParser(description="free-space watcher")
    ap.add_argument("--path", default=os.environ.get("DISK_WATCH_PATH", TENANT))
    ap.add_argument("--state", default=os.path.join(TENANT, "store", "disk-watch.json"))
    ap.add_argument("--free-gb", type=float, help="tests: use this instead of measuring")
    ap.add_argument("--dry-run", action="store_true", help="print the message, send and save nothing")
    args = ap.parse_args(argv)
    try:
        usage = shutil.disk_usage(args.path)
    except OSError as e:
        print("disk-watch: cannot measure %s: %s" % (args.path, e), file=sys.stderr)
        return 1
    free_gb = args.free_gb if args.free_gb is not None else usage.free / GB
    total_gb = usage.total / GB
    warn_gb, crit_gb = thresholds(total_gb, env)
    try:
        prev = json.load(open(args.state))
    except (OSError, ValueError):
        prev = {}
    state, kind = decide(prev if isinstance(prev, dict) else {}, free_gb, int(now if now is not None else time.time()), warn_gb, crit_gb)
    if kind:
        text = message(kind, free_gb, total_gb, warn_gb, crit_gb, args.path)
        if args.dry_run:
            print(text)
            return 0
        if not poster(ALERT_TO, text):
            print("disk-watch: alert not delivered, will retry next run", file=sys.stderr)
            return 0
    elif args.dry_run:
        print("disk-watch: %.1f GB free, level %s, no message" % (free_gb, state["level"]))
        return 0
    try:
        save_state(args.state, state)
    except OSError as e:
        print("disk-watch: cannot save state: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

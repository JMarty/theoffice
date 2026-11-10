#!/usr/bin/env python3
"""service-health.json producer — the DETECTOR half of the 08-01 monitoring-chain contract.

The briefing (morning-briefing-compose skill) READS this file and turns it into a POSITIVE
assertion to the owner — "all N units healthy" or names the unhealthy ones. It is the node where the
monitoring chain bottoms out: the detector watches the units, the briefing watches the detector.
From 2026-08-15 the briefing ALARMS if this file is missing or `checked_at` is older than 2x
`interval_s`, so this producer must run on a timer and stay fresh.

CONTRACT SHAPE (exact, do not drift — a wrong schema makes the briefing lie):
  {checked_at, checked_at_iso, interval_s, units_checked[], units_unwatched[],
   unhealthy[{unit,last_success,hours_since,threshold_h}], unknown[{unit,reason}], healthy_count}

A unit is UNHEALTHY when it has not SUCCEEDED within its threshold (freshness), not merely when it is
inactive-now (oneshots are inactive between runs by design). units_unwatched = fleet timers/services
that are enabled but NOT in WATCHED = scope drift a human should see.
"""
import json
import os
import subprocess
import sys
import time
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
ROOT = os.environ.get("OFFICE_ROOT") or os.path.dirname(TENANT)

STORE = f"{TENANT}/store"
HEALTH_FILE = f"{STORE}/service-health.json"
INTERVAL_S = 300  # this producer's timer cadence; briefing alarms if checked_at older than 2x this

WATCH_CONFIG = os.environ.get("SERVICE_HEALTH_CONFIG", f"{TENANT}/config/service-health.json")
# What to watch is operator config, not code. Shape:
#   {"freshness": {"unit.service": threshold_hours, ...},   timer-driven oneshots: unhealthy when no success within the threshold (~2-3x the unit's cadence)
#    "active": ["unit.service", ...],                        long-running units: healthy iff ActiveState=active
#    "ignored": ["unit.service", ...],                       deliberately not watched (not reported as unwatched drift)
#    "paused_until": {"unit.service": epoch, ...}}           paused ON PURPOSE until that time: neither unknown nor unhealthy before it
try: _cfg = json.load(open(WATCH_CONFIG))
except Exception: _cfg = {}
WATCHED_FRESHNESS = _cfg.get("freshness", {"context-watchdog.service": 1, "drift-detect.service": 1, "disk-watch.service": 1})
WATCHED_ACTIVE = _cfg.get("active", ["theoffice.service", "watchd.service", "theoffice-tmux.service"])
IGNORED = set(_cfg.get("ignored", []))
PAUSED_UNTIL = _cfg.get("paused_until", {})


def show(unit, props):
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show", unit, *[f"--property={p}" for p in props]],
            capture_output=True, text=True, timeout=15).stdout
        return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    except Exception:
        return {}


def to_epoch(ts):
    """Parse a systemd human timestamp ('Mon 2026-08-03 10:05:34 CEST') via `date -d`. 0 if empty."""
    ts = (ts or "").strip()
    if not ts or ts in ("n/a", "0"):
        return 0
    try:
        return int(subprocess.run(["date", "-d", ts, "+%s"], capture_output=True, text=True, timeout=10).stdout.strip())
    except Exception:
        return 0


def enabled_fleet_units():
    """All enabled user timers -> their triggered .service, plus enabled services (for unwatched drift)."""
    units = set()
    try:
        out = subprocess.run(["systemctl", "--user", "list-unit-files", "--state=enabled",
                              "--type=timer,service", "--no-legend"], capture_output=True, text=True, timeout=20).stdout
        for line in out.splitlines():
            u = line.split()[0] if line.split() else ""
            if u.endswith(".timer"):
                units.add(u[:-6] + ".service")  # the service the timer triggers
            elif u.endswith(".service"):
                units.add(u)
    except Exception:
        pass
    return units


now = int(time.time())
checked = []
unhealthy = []
unknown = []
healthy = 0

for unit, threshold_h in WATCHED_FRESHNESS.items():
    checked.append(unit)
    if PAUSED_UNTIL.get(unit, 0) > int(time.time()): continue
    p = show(unit, ["LoadState", "Result", "ExecMainExitTimestamp", "ExecMainStartTimestamp", "ActiveState"])
    if not p or p.get("LoadState") != "loaded":
        unknown.append({"unit": unit, "reason": f"not loaded (LoadState={p.get('LoadState','?')})"})
        continue
    # A oneshot checked mid-run has no ExecMainExitTimestamp yet -> use the start, and fall back to
    # the timer's last-fire; and never flag a unit that is running RIGHT NOW.
    running = p.get("ActiveState") in ("activating", "active", "reloading")
    last = max(to_epoch(p.get("ExecMainExitTimestamp")), to_epoch(p.get("ExecMainStartTimestamp")))
    if last == 0:
        last = to_epoch(show(unit.replace(".service", ".timer"), ["LastTriggerUSec"]).get("LastTriggerUSec"))
    if last == 0:
        unknown.append({"unit": unit, "reason": "no run timestamp on service or its timer"})
        continue
    hours_since = round((now - last) / 3600.0, 1)
    result = p.get("Result", "")
    if result not in ("success", "") and not running:
        unhealthy.append({"unit": unit, "last_success": last, "hours_since": hours_since,
                          "threshold_h": threshold_h, "note": f"last result={result}"})
    elif hours_since > threshold_h and not running:
        unhealthy.append({"unit": unit, "last_success": last, "hours_since": hours_since, "threshold_h": threshold_h})
    else:
        healthy += 1

for unit in WATCHED_ACTIVE:
    checked.append(unit)
    p = show(unit, ["LoadState", "ActiveState", "ActiveEnterTimestamp"])
    if not p or p.get("LoadState") != "loaded":
        unknown.append({"unit": unit, "reason": f"not loaded (LoadState={p.get('LoadState','?')})"})
        continue
    if p.get("ActiveState") == "active":
        healthy += 1
    else:
        last = to_epoch(p.get("ActiveEnterTimestamp"))
        unhealthy.append({"unit": unit, "last_success": last,
                          "hours_since": round((now - last) / 3600.0, 1) if last else None,
                          "threshold_h": 0, "note": f"ActiveState={p.get('ActiveState','?')} (must be active)"})

unwatched = sorted(enabled_fleet_units() - set(checked) - IGNORED - {"service-health.service"})  # self is covered by the file-staleness gate

snapshot = {
    "checked_at": now,
    "checked_at_iso": subprocess.run(["date", "-u", "-d", f"@{now}", "+%Y-%m-%dT%H:%M:%SZ"],
                                     capture_output=True, text=True).stdout.strip(),
    "interval_s": INTERVAL_S,
    "units_checked": checked,
    "units_unwatched": unwatched,
    "unhealthy": unhealthy,
    "unknown": unknown,
    "healthy_count": healthy,
}

tmp = HEALTH_FILE + ".tmp"
with open(tmp, "w") as f:
    json.dump(snapshot, f, indent=1)
os.replace(tmp, HEALTH_FILE)

# ---- edge-triggered alert (2026-11-03: nothing consumed this file in real time; a SIGTERM'd unit is inactive, not failed, so watchd never saw it)
# One bus line to the infra agent when a unit ENTERS unhealthy/unknown (after 2 consecutive runs = ~10 min, so a restart blip is silent), one when it RECOVERS.
# State: store/service-health-alerted.json {"streak": {unit: n}, "alerted": [unit, ...]}. No AI, never raises.
ALERT_STATE = f"{TENANT}/store/service-health-alerted.json"
ALERT_TO = os.environ.get("SERVICE_HEALTH_ALERT_TO", "darryl")
ALERT_AFTER_RUNS = 2


def _alert_edges():
    try:
        st = json.load(open(ALERT_STATE))
    except Exception:
        st = {}
    streak, alerted = st.get("streak", {}), set(st.get("alerted", []))
    cur = {u["unit"]: (u.get("note") or f"last success {u.get('hours_since')} h ago") for u in unhealthy}
    cur.update({u["unit"]: "unknown: " + str(u.get("reason", "?")) for u in unknown})
    streak = {u: streak.get(u, 0) + 1 for u in cur}
    new = sorted(u for u in cur if streak[u] >= ALERT_AFTER_RUNS and u not in alerted)
    back = sorted(alerted - set(cur))
    alerted = (alerted | set(new)) - set(back)
    os.makedirs(os.path.dirname(ALERT_STATE), exist_ok=True)
    json.dump({"streak": streak, "alerted": sorted(alerted)}, open(ALERT_STATE + ".tmp", "w"))
    os.replace(ALERT_STATE + ".tmp", ALERT_STATE)
    return [(u, cur[u]) for u in new], back


def _say(text):
    env = dict(os.environ, OFFICE_AGENT_ID="service-health")
    r = subprocess.run([f"{TENANT}/../tools/agent-msg/agent-msg", ALERT_TO, text[:700]], env=env, capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or "sent id=" not in (r.stdout or ""):
        print("alert not sent:", (r.stdout or r.stderr or "")[:120], file=sys.stderr)


try:
    _new, _back = _alert_edges()
    if _new:
        _say("SERVICE-HEALTH DOWN: " + "; ".join(f"{u} ({n})" for u, n in _new)[:560] + ". Check: systemctl --user status <unit>; restart if it is a client demo.")
    if _back:
        _say("SERVICE-HEALTH recovered: " + ", ".join(_back))
except Exception as _e:      # the alert must never break the producer
    print("alert step failed:", type(_e).__name__, file=sys.stderr)

if "--print" in sys.argv:
    print(json.dumps(snapshot, indent=1))

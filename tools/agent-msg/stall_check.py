"""Main-inbox stall observer: bus messages addressed to the main agent that do not reach it mean nobody is reading the bus. Two signals: an agent_messages row
still 'pending' (the engine's bus tick is not running) and an inbound_queue row from the bus still 'queued' or 'delivering' (the engine moved it but the pane never took it).
Owner (channel) messages are NOT covered here: frozen-pane-alarm and owner-watchdog already watch those.

Runs inside an existing watchdog timer (owner-watchdog), reading the DB directly so it works while the dashboard process is down.
Alerts at most once per cooldown; a failed alert does not consume the cooldown. Always rewrites a stamp ("checked_at") so the
service-health freshness check can see the observer itself is alive.
"""
import json
import sqlite3
import time


def check(db_path, main_agent, state_path, now, stall_sec, cooldown_sec, send):
    """-> {"stalled": n, "alerted": bool}. `send(text)` returns True when the alert went out."""
    try:
        state = json.load(open(state_path))
    except (OSError, ValueError):
        state = {}
    try:
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    except sqlite3.OperationalError:
        c = sqlite3.connect(db_path, timeout=5)  # -readonly cannot open a WAL db whose -shm is gone (a stopped dashboard leaves exactly that)
    try:
        rows = c.execute("SELECT id, from_agent, created_at FROM agent_messages WHERE to_agent=? AND status='pending' AND created_at<=? ORDER BY id", (main_agent, now - stall_sec)).fetchall()
        try:
            rows += c.execute("SELECT id, source, created_at FROM inbound_queue WHERE agent_id=? AND source='bus' AND status IN ('queued','delivering') AND created_at<=? ORDER BY id", (main_agent, now - stall_sec)).fetchall()
        except sqlite3.OperationalError:
            pass  # no inbound_queue table (old/partial db): the pending-row signal still stands
    finally:
        c.close()
    alerted = False
    if rows and now - state.get("last_alert", 0) >= cooldown_sec:
        oldest = (now - min(r[2] for r in rows)) // 60
        text = (f"[inbox-stall] {len(rows)} message(s) to {main_agent} have not been taken for {stall_sec // 60}+ min (oldest {oldest} min, ids "
                f"{', '.join(str(r[0]) for r in rows[:8])}). Either {main_agent} is in a long turn or nobody is reading the bus: check the {main_agent} session and the engine.")
        if send(text):
            state["last_alert"] = now
            alerted = True
    state["checked_at"] = now
    try:
        json.dump(state, open(state_path, "w"))
    except OSError:
        pass
    return {"stalled": len(rows), "alerted": alerted}

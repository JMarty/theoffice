#!/usr/bin/env python3
"""Add (or remove) the agent-state observe-only hooks in a Claude Code settings.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
Notification, Stop, SessionEnd. Idempotent, keeps every other hook, writes a .bak-agentstate copy first. Agents named in AGENT_STATE_AGENTS
(default darryl) record events; every other agent's hook exits in ~2 ms. Hooks load at session start.
  install_hook.py [--settings FILE] [--root ENGINE_ROOT] [--tenant TENANT_ROOT] [--remove]"""
import argparse
import json
import os
import shutil
import sys

MARK = "agent-state/agent-state-hook.sh"
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"]


def command(root, tenant):
    return f"AGENT_STATE_DIR={os.path.join(tenant, 'store', 'agent-state')} sh {os.path.join(root, 'tools', 'agent-state', 'agent-state-hook.sh')}"


def apply(settings, root, tenant, remove=False):
    s = json.loads(json.dumps(settings))
    hooks = s.setdefault("hooks", {})
    for ev in EVENTS:
        groups = hooks.setdefault(ev, [])
        groups[:] = [g for g in groups if not any(MARK in (h.get("command") or "") for h in g.get("hooks", []))]
        if not remove:
            groups.append({"hooks": [{"type": "command", "command": command(root, tenant), "timeout": 5}]})
        if not groups:
            del hooks[ev]
    if not hooks:
        del s["hooks"]
    return s


def main(argv):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", default=os.path.expanduser("~/.claude/settings.json"))
    ap.add_argument("--root", default=root)
    ap.add_argument("--tenant", default=os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(root, "tenant"))
    ap.add_argument("--remove", action="store_true")
    a = ap.parse_args(argv)
    cur = json.load(open(a.settings)) if os.path.exists(a.settings) else {}
    new = apply(cur, a.root, a.tenant, a.remove)
    if new == cur:
        print("settings unchanged")
        return 0
    if os.path.exists(a.settings):
        shutil.copy2(a.settings, a.settings + ".bak-agentstate")
    tmp = a.settings + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, a.settings)
    print("agent-state hooks removed" if a.remove else "agent-state hooks installed (observe-only; the next session of a trial agent starts recording)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

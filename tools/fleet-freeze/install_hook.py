#!/usr/bin/env python3
"""Add (or remove) the fleet-freeze PreToolUse hook (matcher: every tool) in a Claude Code settings.json. Idempotent, keeps every other hook and
setting (including the email-send-gate hook), writes a .bak-freeze copy first.
  install_hook.py [--settings FILE] [--root ENGINE_ROOT] [--tenant TENANT_ROOT] [--remove]
Claude Code reads hooks when a session STARTS: agents pick this up on their next (re)start, so a fleet restart is needed once after installing."""
import argparse
import json
import os
import shutil
import sys

MARK = "fleet-freeze/freeze-hook.sh"


def command(root, tenant):
    return f"sh {os.path.join(root, 'tools', 'fleet-freeze', 'freeze-hook.sh')} {os.path.join(tenant, 'store', 'fleet-freeze.json')}"


def apply(settings, root, tenant, remove=False):
    s = json.loads(json.dumps(settings))
    pre = s.setdefault("hooks", {}).setdefault("PreToolUse", [])
    pre[:] = [g for g in pre if not any(MARK in (h.get("command") or "") for h in g.get("hooks", []))]
    if not remove:
        pre.insert(0, {"matcher": "*", "hooks": [{"type": "command", "command": command(root, tenant), "timeout": 5}]})  # first: a freeze must win over every other hook
    if not pre:
        del s["hooks"]["PreToolUse"]
    if not s["hooks"]:
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
        shutil.copy2(a.settings, a.settings + ".bak-freeze")
    tmp = a.settings + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, a.settings)
    print("freeze hook removed" if a.remove else "freeze hook installed (agents pick it up on their next start)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

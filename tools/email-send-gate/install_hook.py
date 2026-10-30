#!/usr/bin/env python3
"""Add (or remove) the email-send-gate PreToolUse hook in a Claude Code settings.json. Idempotent; keeps every other setting and hook;
writes a .bak-emailgate copy first. Default target: ~/.claude/settings.json (shared by every agent on the box).
  install_hook.py [--settings FILE] [--root ENGINE_ROOT] [--remove]"""
import argparse
import json
import os
import shutil
import sys

MATCHER = "Bash|mcp__claude_ai_Gmail__(send_message|reply|forward)|mcp__claude_ai_Mailbox_MCP__(send_email|send_draft|reply_email|forward_email)"
MARK = "email-send-gate/email_gate.py"


def command(root):
    return f"python3 {os.path.join(root, 'tools', 'email-send-gate', 'email_gate.py')} hook"


def apply(settings, root, remove=False):
    """-> new settings dict (input is not mutated)."""
    s = json.loads(json.dumps(settings))
    pre = s.setdefault("hooks", {}).setdefault("PreToolUse", [])
    pre[:] = [g for g in pre if not any(MARK in (h.get("command") or "") for h in g.get("hooks", []))]  # drop any earlier copy of ours
    if not remove:
        pre.append({"matcher": MATCHER, "hooks": [{"type": "command", "command": command(root), "timeout": 10}]})
    if not pre:
        del s["hooks"]["PreToolUse"]
    if not s["hooks"]:
        del s["hooks"]
    return s


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", default=os.path.expanduser("~/.claude/settings.json"))
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    ap.add_argument("--remove", action="store_true")
    a = ap.parse_args(argv)
    cur = json.load(open(a.settings)) if os.path.exists(a.settings) else {}
    new = apply(cur, a.root, a.remove)
    if new == cur:
        print("settings unchanged")
        return 0
    if os.path.exists(a.settings):
        shutil.copy2(a.settings, a.settings + ".bak-emailgate")
    tmp = a.settings + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, a.settings)
    print("hook removed" if a.remove else "hook installed (mode is set by store/email-gate.mode, default log)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

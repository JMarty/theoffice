#!/usr/bin/env python3
"""Add (or remove) the skill-router UserPromptSubmit hook in a Claude Code settings.json.
Idempotent, keeps every other hook, writes a .bak-skillrouter copy first. Hooks load at session start.
  install_hook.py [--settings FILE] [--root ENGINE_ROOT] [--remove]"""
import argparse
import json
import os
import shutil
import sys

MARK = "skill-router/route.py"


def apply(settings, root, remove=False):
    s = json.loads(json.dumps(settings))
    hooks = s.setdefault("hooks", {})
    groups = hooks.setdefault("UserPromptSubmit", [])
    for g in groups:                       # drop only our own entry: a group may also carry other hooks
        g["hooks"] = [h for h in g.get("hooks", []) if MARK not in (h.get("command") or "")]
    groups[:] = [g for g in groups if g["hooks"]]
    if not remove:
        cmd = f"python3 {os.path.join(root, 'tools', 'skill-router', 'route.py')} 2>/dev/null || true"
        groups.append({"hooks": [{"type": "command", "command": cmd, "timeout": 5}]})
    if not groups:
        del hooks["UserPromptSubmit"]
    if not hooks:
        del s["hooks"]
    return s


def main(argv):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", default=os.path.expanduser("~/.claude/settings.json"))
    ap.add_argument("--root", default=root)
    ap.add_argument("--remove", action="store_true")
    a = ap.parse_args(argv)
    cur = json.load(open(a.settings)) if os.path.exists(a.settings) else {}
    new = apply(cur, a.root, a.remove)
    if new == cur:
        print("settings unchanged")
        return 0
    if os.path.exists(a.settings):
        shutil.copy2(a.settings, a.settings + ".bak-skillrouter")
    os.makedirs(os.path.dirname(a.settings), exist_ok=True)
    tmp = a.settings + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, a.settings)
    print("skill-router hook removed" if a.remove else "skill-router hook installed (next session picks it up)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

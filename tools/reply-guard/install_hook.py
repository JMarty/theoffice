#!/usr/bin/env python3
"""Add (or remove) the reply-guard Stop hook in a Claude Code settings.json. Idempotent, keeps every other hook/setting, writes a .bak-replyguard copy.
  install_hook.py [--settings FILE] [--root ENGINE_ROOT] [--remove]
The hook only acts for the agent named in REPLY_GUARD_AGENT (default marveen); everyone else exits at once. Sessions read hooks at start: restart the main agent once."""
import argparse
import json
import os
import shutil
import sys

MARK = "reply-guard/reply_guard.py"


def apply(settings, root, remove=False):
    s = json.loads(json.dumps(settings))
    stop = s.setdefault("hooks", {}).setdefault("Stop", [])
    stop[:] = [g for g in stop if not any(MARK in (h.get("command") or "") for h in g.get("hooks", []))]
    if not remove:
        stop.append({"hooks": [{"type": "command", "command": f"python3 {os.path.join(root, 'tools', 'reply-guard', 'reply_guard.py')} hook", "timeout": 10}]})
    if not stop:
        del s["hooks"]["Stop"]
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
        shutil.copy2(a.settings, a.settings + ".bak-replyguard")
    tmp = a.settings + ".tmp"
    with open(tmp, "w") as f:
        json.dump(new, f, indent=2)
    os.replace(tmp, a.settings)
    print("hook removed" if a.remove else "hook installed (mode: store/reply-guard.mode, default log)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

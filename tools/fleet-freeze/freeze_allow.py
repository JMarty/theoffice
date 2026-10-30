#!/usr/bin/env python3
"""What a frozen agent may still do: SPEAK to the owner. Reads the PreToolUse payload on stdin; exit 0 = allow, anything else = deny.

Only a Bash call that is nothing but a plain office-say is let through, in one of two shapes:
  office-say "text"  /  office-say 'text'     (one quoted argument; no $, backtick, backslash, quote of the same kind inside)
  office-say <<'EOF' ... EOF                  (quoted heredoc delimiter, so nothing in the body is expanded; nothing before or after)
Everything else is denied: a second command, a pipe or redirect, a substitution, another tool, garbled input. The freeze stops agent WORK; an agent
that cannot tell the owner it is frozen would be worse than one that can.
"""
import json
import re
import sys

ARG = r"""(?:"[^"`$\\\n]*"|'[^'\n]*')"""
ONE_ARG = re.compile(rf"^\s*office-say[ \t]+{ARG}[ \t]*$")
HEREDOC = re.compile(r"^\s*office-say[ \t]+<<[ \t]*'(?P<tag>[A-Za-z_][A-Za-z0-9_]*)'[ \t]*\n(?P<body>.*)\n(?P=tag)[ \t]*\n?$", re.S)


def allowed(payload):
    if payload.get("tool_name") != "Bash":
        return False
    cmd = (payload.get("tool_input") or {}).get("command")
    if not isinstance(cmd, str):
        return False
    if ONE_ARG.match(cmd):
        return True
    m = HEREDOC.match(cmd)
    if m:
        # the tag must not occur earlier as a line of its own (that would end the heredoc early and let the rest run as commands)
        return not any(line.strip() == m.group("tag") for line in m.group("body").split("\n"))
    return False


if __name__ == "__main__":
    try:
        sys.exit(0 if allowed(json.load(sys.stdin)) else 2)
    except Exception:
        sys.exit(2)

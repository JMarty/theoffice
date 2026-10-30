#!/usr/bin/env python3
"""reply-guard: a Claude Code Stop hook for the MAIN agent only. If the turn that is ending answered an owner Slack message but no reply was
actually sent to the owner (no office-say / Slack send after that message), the stop is blocked ONCE with a reminder, so a reply written as
plain text in the transcript (where nobody reads it) is sent before the turn ends.

Scope and safety:
  - runs only when OFFICE_AGENT_ID equals REPLY_GUARD_AGENT (default marveen); the hook sits in the shared ~/.claude/settings.json, every other agent exits at once;
  - only turns started by "[Slack message from the owner]": heartbeats, scheduled tasks, bus messages and task notifications are skipped (silence is correct there);
  - owner closers ("ok", "thanks", an emoji) need no reply: the same strict classifier as owner-ack-guard (a "?" is never a closer);
  - never loops: when Claude Code reports stop_hook_active the stop is always allowed, so at most ONE block per stop;
  - any error, unreadable transcript or garbled input = allow (fail open);
  - while the fleet is FROZEN (store/fleet-freeze.json) it always allows: the freeze hook denies every tool, including office-say, so demanding a send would only waste a loop;
  - mode file store/reply-guard.mode: "log" (default) records what it WOULD block and blocks nothing; "enforce" blocks. Log lines never contain message text.
owner-ack-guard and owner-watchdog stay as the backstop for the case this hook cannot see.

  reply_guard.py hook                  (stdin = Stop hook JSON)
  reply_guard.py replay [--days 7]     (what it would have done on the real transcripts of the main agent)
"""
import argparse
import glob
import importlib.util
import json
import os
import sys
import time

TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
STORE = os.path.join(TENANT, "store")
OWNER_PREFIX = "[Slack message from the owner]"
# user-role entries that are part of the SAME turn, not a new prompt (an image note, a skill loaded by the Skill tool, a hook/system reminder)
CONTINUATION = ("[Image:", "Base directory for this skill", "<system-reminder>")
import re
SEND_CMD = re.compile(r"office-say|slack-file|files\.(upload|completeUploadExternal|getUploadURLExternal)|chat\.postMessage")  # every way this fleet puts a message or file in front of the owner on Slack
SEND_TOOL_HINTS = ("slack_send_message", "slack_schedule_message")
REASON = ("The owner's Slack message is still unanswered: your reply exists only in this transcript, where nobody reads it. "
          "Send it now with office-say (or the Slack send tool), then stop. If no reply is needed, say so in one short office-say line.")


def _needs_no_reply(text):
    """The owner-ack-guard closer classifier (strict: a '?' is never a closer)."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "owner-ack-guard", "owner_ack_guard.py")
    spec = importlib.util.spec_from_file_location("owner_ack_guard", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.needs_no_reply(text)


def _text_of(entry):
    c = (entry.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        if c and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return None  # a tool result, not a prompt
        return " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return None


def _is_reply(entry):
    if entry.get("type") != "assistant":
        return False
    for b in (entry.get("message") or {}).get("content") or []:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        name = b.get("name", "")
        if name == "Bash" and SEND_CMD.search(str((b.get("input") or {}).get("command", ""))):
            return True
        if any(h in name for h in SEND_TOOL_HINTS):
            return True
    return False


def last_prompt(entries):
    """-> (index, text) of the last real prompt in the turn, or (None, None). Image notes are continuations of the message before them."""
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        if e.get("type") != "user":
            continue
        t = _text_of(e)
        if t is None or not t.strip() or t.lstrip().startswith(CONTINUATION):
            continue
        return i, t
    return None, None


def evaluate(entries, stop_hook_active):
    """-> {"decision": "allow"|"block", "reason": ...}. Pure."""
    if stop_hook_active:
        return {"decision": "allow", "reason": "stop_hook_active"}
    i, t = last_prompt(entries)
    if i is None or not t.lstrip().startswith(OWNER_PREFIX):
        return {"decision": "allow", "reason": "not an owner turn"}
    body = t.lstrip()[len(OWNER_PREFIX):].strip()
    if _needs_no_reply(body):
        return {"decision": "allow", "reason": "closer"}
    if any(_is_reply(e) for e in entries[i + 1:]):
        return {"decision": "allow", "reason": "answered"}
    return {"decision": "block", "reason": REASON}


def read_mode(store=STORE):
    try:
        m = open(os.path.join(store, "reply-guard.mode")).read().strip().lower()
    except OSError:
        return "log"
    return m if m in ("log", "enforce") else "log"


def _load(path):
    out = []
    with open(path, errors="replace") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def hook_main(stdin, stdout, env=os.environ, store=STORE, mode=None):
    try:
        payload = json.load(stdin)
        if env.get("OFFICE_AGENT_ID", "") != env.get("REPLY_GUARD_AGENT", "marveen"):
            return 0
        if os.path.exists(os.path.join(store, "fleet-freeze.json")):
            return 0  # frozen: no tool can run, a reminder to send could not be obeyed
        entries = _load(payload["transcript_path"])
        r = evaluate(entries, bool(payload.get("stop_hook_active")))
    except Exception:
        return 0  # fail open
    mode = mode or read_mode(store)
    if r["decision"] == "block" or r["reason"] == "answered":
        try:
            os.makedirs(store, exist_ok=True)
            with open(os.path.join(store, "reply-guard.log.jsonl"), "a") as f:
                f.write(json.dumps({"ts": int(time.time()), "mode": mode, "agent": env.get("OFFICE_AGENT_ID"), "would": r["decision"], "why": "no reply sent" if r["decision"] == "block" else "answered"}) + "\n")
        except OSError:
            pass
    if r["decision"] == "block" and mode == "enforce":
        stdout.write(json.dumps({"decision": "block", "reason": r["reason"]}))
    return 0


def replay(paths):
    """Walk transcripts turn by turn: for each owner Slack turn, what would the guard have done at that turn's end?"""
    res = {"owner_turns": 0, "answered": 0, "closers": 0, "would_block": 0, "samples": []}
    for p in paths:
        try:
            entries = _load(p)
        except OSError:
            continue
        starts = [i for i, e in enumerate(entries) if e.get("type") == "user" and (_text_of(e) or "").lstrip().startswith(OWNER_PREFIX)]
        for n, s in enumerate(starts):
            nxt = next((j for j in range(s + 1, len(entries)) if entries[j].get("type") == "user" and (_text_of(entries[j]) or "").strip()
                        and not (_text_of(entries[j]) or "").lstrip().startswith(CONTINUATION)), len(entries))
            r = evaluate(entries[s:nxt], False)
            res["owner_turns"] += 1
            if r["reason"] == "answered":
                res["answered"] += 1
            elif r["reason"] == "closer":
                res["closers"] += 1
            elif r["decision"] == "block":
                res["would_block"] += 1
                if len(res["samples"]) < 15:
                    res["samples"].append({"file": os.path.basename(p)[:8], "ts": (entries[s].get("timestamp") or "")[:16], "len": len(_text_of(entries[s]) or "")})
    return res


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hook")
    r = sub.add_parser("replay"); r.add_argument("--days", type=int, default=7); r.add_argument("--agent-dir", default=os.path.expanduser("~/.claude/projects/-opt-claude-theoffice-tenant-agents-marveen"))
    a = ap.parse_args(argv)
    if a.cmd == "hook":
        return hook_main(sys.stdin, sys.stdout)
    cut = time.time() - a.days * 86400
    files = [f for f in glob.glob(os.path.join(a.agent_dir, "*.jsonl")) if os.path.getmtime(f) > cut]
    print(json.dumps({"transcripts": len(files), **replay(files)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

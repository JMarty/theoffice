#!/usr/bin/env python3
"""email-send gate: a Claude Code PreToolUse hook that stops an agent from SENDING email unless the owner's "send it"
has been recorded as a one-shot approval for that exact message.

What it guards: the Gmail MCP send_message / reply / forward, the Mailbox MCP send_email / send_draft / reply_email /
forward_email, and Bash commands that send mail directly (Gmail API messages/send + drafts/send, smtplib, sendmail).
Drafting is never touched. An approval is a small file keyed by the message itself (recipients + subject + body for
composed mail, the draft uid for send_draft, the command for Bash); the hook consumes it when the matching send happens,
so it works once. Approvals expire (default 30 min).

Modes (store/email-gate.mode): "log" (default, anything unrecognised) never blocks and only records what it WOULD have
done in store/email-gate.log.jsonl; "enforce" denies sends without a matching approval. Switch to enforce only after the
log shows zero false blocks on real flows (see `replay`).

Honest limit: approvals live on the same machine and user as the agents, so this makes an unapproved send an explicit,
logged step instead of an accident; it is not a security boundary against an agent that deliberately forges one.
The approve command refuses agents other than the approver (EMAIL_GATE_APPROVER, default the main agent) as a convention.

CLI:  email_gate.py hook                      (stdin = Claude Code hook JSON; used by settings.json)
      email_gate.py approve TOOL ARGS_JSON    (ARGS_JSON = the exact tool arguments; "-" reads stdin) [--ttl-min N]
      email_gate.py replay [--days 7]         (what the gate would have done on real transcripts)
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
STORE = os.path.join(TENANT, "store")
TTL_MIN = 30

COMPOSE = {
    "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward",
    "mcp__claude_ai_Mailbox_MCP__send_email", "mcp__claude_ai_Mailbox_MCP__reply_email", "mcp__claude_ai_Mailbox_MCP__forward_email",
}
DRAFT_SEND = {"mcp__claude_ai_Mailbox_MCP__send_draft"}
# A Bash command SENDS mail only if the send is the shape of an executed request, not a mention: a python request call whose URL is the Gmail
# send endpoint, curl against it, smtplib.SMTP(...), or the sendmail command. A grep / git message / file being written that merely names the
# endpoint must not match (found by replaying a week of real commands: those were the false blocks).
BASH_SEND = re.compile(
    r"((urlopen|Request|requests\.(post|request)|httpx\.post)\s*\(\s*[^)]{0,300}?(messages|drafts)/send"
    r"|\bcurl\b[^\n|;]*gmail\.googleapis\.com/gmail/v1/users/[^/\s'\"]+/(messages|drafts)/send"
    r"|\bsmtplib\.SMTP(_SSL)?\s*\([^)]*\)[\s\S]{0,400}?\.(sendmail|send_message)\s*\("
    r"|(^|[;&|(]\s*|\n\s*)sendmail(\s+-|\s*<|\s*$))", re.I)
# a python script that PATCHES source text (replace / write_text / open(...,"w")) and carries the endpoint as data is editing a mailer, not sending.
# Cost of this rule: a send script that also writes a file in the same command is not seen; the log-only replay is how to size that.
PATCHER = re.compile(r"\.replace\(|\bwrite_text\(|\bopen\([^)]*,\s*['\"][wa]b?['\"]")
FILE_WRITE = re.compile(r"(\bcat\s*>>?\s*\S+|\btee\b)[^\n]*<<")  # a heredoc being written to a file is data, not an execution


def _norm_text(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _norm_addr(v):
    items = v if isinstance(v, list) else ([v] if v else [])
    return sorted(str(x).strip().lower() for x in items if str(x).strip())


def _digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def classify(tool, inp):
    """-> None (not an email send) or {"kind", "key", "label"}. The label is for logs and never carries the body."""
    inp = inp if isinstance(inp, dict) else {}
    if tool in COMPOSE:
        norm = {"tool": tool.rsplit("__", 1)[-1], "to": _norm_addr(inp.get("to")), "cc": _norm_addr(inp.get("cc")), "bcc": _norm_addr(inp.get("bcc")),
                "subject": _norm_text(inp.get("subject")), "body": _norm_text(inp.get("body") or inp.get("text") or inp.get("html")),
                "ref": str(inp.get("uid") or inp.get("messageId") or inp.get("threadId") or "")}
        return {"kind": "compose", "key": _digest(norm), "label": f"{norm['tool']} to {', '.join(norm['to']) or '?'} subject '{norm['subject'][:60]}'"}
    if tool in DRAFT_SEND:
        uid = inp.get("uid", inp.get("draftId", inp.get("id")))
        return {"kind": "draft", "key": _digest({"draft": str(uid), "folder": str(inp.get("folder", ""))}), "label": f"send_draft uid {uid}"}
    if tool == "Bash":
        cmd = str(inp.get("command", ""))
        m = BASH_SEND.search(cmd)
        if m and not FILE_WRITE.search(cmd[: m.start()]) and not PATCHER.search(cmd):
            return {"kind": "bash", "key": _digest({"bash": _norm_text(cmd)}), "label": "bash mail send: " + _norm_text(cmd)[:80]}
    return None


def approvals_dir(store):
    return os.path.join(store, "email-approvals")


def approve(store, tool, inp, by, now=None, ttl_min=TTL_MIN):
    c = classify(tool, inp)
    if not c:
        raise ValueError(f"{tool} is not an email-sending call")
    now = int(now if now is not None else time.time())
    os.makedirs(approvals_dir(store), exist_ok=True)
    path = os.path.join(approvals_dir(store), c["key"] + ".json")
    with open(path, "w") as f:
        json.dump({"key": c["key"], "kind": c["kind"], "label": c["label"], "approved_by": by, "created_at": now, "expires_at": now + ttl_min * 60}, f)
    os.chmod(path, 0o600)
    return c


def _consume(store, key, now):
    """Spend the approval atomically (rename): True if a valid one existed and was consumed by us."""
    path = os.path.join(approvals_dir(store), key + ".json")
    try:
        rec = json.load(open(path))
    except (OSError, ValueError):
        return False
    if rec.get("expires_at", 0) < now:
        return False
    try:
        os.rename(path, path + f".used-{now}")
    except OSError:
        return False  # another call spent it first
    return True


def _has(store, key, now):
    try:
        return json.load(open(os.path.join(approvals_dir(store), key + ".json"))).get("expires_at", 0) >= now
    except (OSError, ValueError):
        return False


def _log(store, rec):
    try:
        os.makedirs(store, exist_ok=True)
        with open(os.path.join(store, "email-gate.log.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass


def decide(tool, inp, store, mode, now):
    c = classify(tool, inp)
    if not c:
        return {"action": "allow", "reason": "not an email send", "would_deny": False}
    agent = os.environ.get("OFFICE_AGENT_ID", "")
    if mode != "enforce":
        matched = _has(store, c["key"], now)
        _log(store, {"ts": int(now), "mode": "log", "agent": agent, "tool": tool, "kind": c["kind"], "label": c["label"], "token_matched": matched, "would_deny": not matched})
        return {"action": "allow", "reason": "log mode", "would_deny": not matched, "token_matched": matched}
    ok = _consume(store, c["key"], now)
    _log(store, {"ts": int(now), "mode": "enforce", "agent": agent, "tool": tool, "kind": c["kind"], "label": c["label"], "token_matched": ok, "would_deny": not ok})
    if ok:
        return {"action": "allow", "reason": "approved", "would_deny": False, "token_matched": True}
    return {"action": "deny", "would_deny": True, "reason": (
        f"Email send blocked: no owner approval for this exact message ({c['label']}). Sending email on the owner's behalf needs his explicit "
        f"\"send it\" for THIS message. Show him the text, and when he approves, the main agent records it with: "
        f"python3 tools/email-send-gate/email_gate.py approve {tool} '<the exact tool arguments as JSON>' ; then repeat the send (the approval works once, 30 min).")}


def read_mode(store):
    try:
        m = open(os.path.join(store, "email-gate.mode")).read().strip().lower()
    except OSError:
        return "log"
    return m if m in ("log", "enforce") else "log"


def hook_main(stdin, stdout, store=STORE, mode=None, now=None):
    try:
        payload = json.load(stdin)
        tool, inp = payload.get("tool_name", ""), payload.get("tool_input", {})
    except (ValueError, AttributeError):
        return 0  # unparseable: not ours to block
    r = decide(tool, inp, store, mode or read_mode(store), int(now if now is not None else time.time()))
    if r["action"] == "deny":
        stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": r["reason"]}}))
    return 0


def replay(paths):
    """What the gate sees in real transcripts: every email-sending tool call, counted by tool. (No approval history exists
    to match against, so `would_deny_without_approval` equals `sends`; the point is the surface, and that nothing else matches.)"""
    by_tool, sends, samples = {}, 0, []
    for p in paths:
        try:
            lines = open(p, errors="replace")
        except OSError:
            continue
        for l in lines:
            if "tool_use" not in l:
                continue
            try:
                d = json.loads(l)
            except ValueError:
                continue
            content = (d.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    c = classify(b.get("name", ""), b.get("input"))
                    if c:
                        sends += 1
                        by_tool[b["name"]] = by_tool.get(b["name"], 0) + 1
                        if len(samples) < 20:
                            samples.append({"file": os.path.basename(os.path.dirname(p))[-40:], "ts": (d.get("timestamp") or "")[:16], "tool": b["name"], "label": c["label"]})
    return {"sends": sends, "by_tool": by_tool, "samples": samples}


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hook")
    a = sub.add_parser("approve"); a.add_argument("tool"); a.add_argument("args_json"); a.add_argument("--ttl-min", type=int, default=TTL_MIN)
    r = sub.add_parser("replay"); r.add_argument("--days", type=int, default=7)
    args = ap.parse_args(argv)
    if args.cmd == "hook":
        return hook_main(sys.stdin, sys.stdout)
    if args.cmd == "approve":
        me = os.environ.get("OFFICE_AGENT_ID", "")
        approver = os.environ.get("EMAIL_GATE_APPROVER", "marveen")
        if me and me != approver:
            print(f"email_gate: only {approver} records approvals (you are {me}); ask them after the owner says 'send it'", file=sys.stderr)
            return 2
        raw = sys.stdin.read() if args.args_json == "-" else args.args_json
        c = approve(STORE, args.tool, json.loads(raw), by=me or "cli", ttl_min=args.ttl_min)
        print(f"approved once for {args.ttl_min} min: {c['label']}")
        return 0
    if args.cmd == "replay":
        import glob
        cut = time.time() - args.days * 86400
        files = [f for f in glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True) if os.path.getmtime(f) > cut]
        out = replay(files)
        print(json.dumps({"transcripts": len(files), **out}, indent=1))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

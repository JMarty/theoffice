# email-send-gate

PreToolUse hook that blocks email sends unless the owner's "send it" was recorded for that exact message (one-shot approval, 30 min).
Guards the Gmail MCP (send_message, reply, forward), the Mailbox MCP (send_email, send_draft, reply_email, forward_email) and Bash commands
that execute a Gmail API send, smtplib or sendmail. Drafting is never touched.

- `email_gate.py hook` is the hook; `approve` records an approval; `replay --days 7` shows what it would have seen in real transcripts.
- `install_hook.py` merges the hook into `~/.claude/settings.json` (idempotent, backup, `--remove`).
- Mode: `store/email-gate.mode` = `log` (default: never blocks, logs `would_deny`) or `enforce`. Log first, enforce after a clean replay.
- Limit: approvals sit on the same machine and user as the agents. This turns an unapproved send into an explicit, logged step; it does not stop an agent that deliberately forges an approval.
- Known blind spot: a send script that is saved to a file and run by name, or a Bash command that both sends and writes a file in the same call, is not recognised.
Tests: `python3 -m unittest discover -s tools/email-send-gate -p 'test_*.py'`

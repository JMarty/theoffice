---
name: email-send-approval
description: Record the owner's "send it" for ONE specific email so the send gate lets exactly that message through. Use after the owner approves a drafted email, before the send call.
---

# Email send approval

The email send gate (a PreToolUse hook) blocks every email send unless the owner's approval was recorded for that exact message. Drafting is never blocked.

1. Show the owner the exact text (recipients, subject, body) and wait for an explicit "send it" for THIS message. An earlier yes for a different draft, or a general "go ahead with the mails", is not it.
2. Record it (main agent only), passing the exact arguments you are about to send:
   `python3 $OFFICE_ROOT/tools/email-send-gate/email_gate.py approve <tool_name> '<tool arguments as JSON>'`
   Examples: `mcp__claude_ai_Gmail__send_message '{"to":["a@example.com"],"subject":"...","body":"..."}'`, `mcp__claude_ai_Mailbox_MCP__send_draft '{"uid":670}'`.
3. Send within 30 minutes. The approval works once and only for an identical message: a changed word, recipient or draft needs a new approval.
4. If the gate still blocks, do not look for another route to send. Tell the owner and ask again.

Mode: `<tenant>/store/email-gate.mode` holds `log` (records what it would block, blocks nothing) or `enforce`. Decisions are in `<tenant>/store/email-gate.log.jsonl`.

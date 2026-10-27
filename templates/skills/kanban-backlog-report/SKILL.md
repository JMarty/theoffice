---
name: kanban-backlog-report
description: Generate a structured backlog snapshot for Owner on demand. Use when Owner asks "what's in the backlog", "what's on the board", "status of tasks", "what's open". Groups by priority (urgent/high/normal) and status, then highlights items specifically gated on Owner's action.
---

# Kanban Backlog Report

## When to use
- Owner asks: "what's in the backlog", "what's on the board", "show me the tasks", "what's open", "status report"
- NOT for the morning briefing (use morning-briefing-compose for that)

## Procedure

### 1. Pull all active cards
```bash
curl -s -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" \
  "http://localhost:3420/api/kanban"
```

### 2. Group + format
Order: urgent → high → normal → low. Within each priority: in_progress → waiting → planned → done (omit done).

Format each line: `[priority/status] <title> -- <assignee>` plus a one-line context cue if you have it (e.g. "blocked on YOUR review", "booked for Friday").

### 3. Add WAITING ON YOU section
Cross-reference team status to surface items specifically gated on Owner. Include:
- Calls/decisions Owner owes
- OAuth or auth flows needed from him
- Vendor calls only he can make
- Reviews/signal-offs blocking agents

BEFORE listing an item as "waiting on you", filter it through these tests — if it fails any, it is NOT waiting on Owner:
- **Already decided?** If a date/choice was already agreed (e.g. "the review starts Monday"), it is tracking, not a pending decision. Don't surface it.
- **Downstream dependency?** If it can't happen until an earlier task finishes (e.g. "publish the page" needs copy + images first), it's blocked on the dependency, not on Owner. Don't surface it as his decision now.
- **Genuinely needs HIS input?** Only items where the next move is literally his (a review only he can do, a choice only he can make, a personal errand). Everything else is the team's to push.
Failure mode: surfacing an already-agreed item or one blocked on a dependency as "waiting on you". Over-padding the list erodes trust.

### 4. Footer
"N cards open total. M things specifically gated on you. Want me to highlight a quick-win subset?"

### 5. Send via Telegram, plain text, ━━━━━━━━━━━━━━━━━━━━ separators.

## Pitfalls

- **Don't list `done` status cards** — they clutter the view. The dashboard shows them separately.
- **Real card titles + assignee** — never paraphrase or invent. Pull from the API response verbatim.
- **"Waiting on you" needs to be specific** — generic "you need to decide" is useless. Cite what's blocked (which agent, which deliverable, what action).
- **Agent_id vs character name**: assignee field uses tmux agent_ids. Translate for Owner if he prefers character names (Oscar instead of cfo).
- **Don't infer action from email signatures**: a phone number in someone's signature is NOT "they want a call". Read the email BODY for the actual ask. Example: a signature had a number, but the body only described how something was resolved — purely informational, so no call belongs on the to-do.
- **Agents can't make phone calls**: they're Claude agents, no voice. If a backlog item says "call vendor", translate to "email vendor" or "research and propose email candidates". Apply to every agent equally.
- **Don't flag device states without understanding their semantics**: an entity that reads "on" may only mean a monitoring socket is on, not that the appliance is running. Check what it actually measures before flagging; when in doubt, ask the home agent.
- **Net-cost vs gross-cost**: a recurring expense paid by us but reimbursed by another party is NOT a real cost. Same for expenses fronted for cashflow: funding mechanism ≠ economic classification. Always distinguish when summarizing burn / runway.

## Verification
- Card count in footer matches actual API response
- All priorities represented if cards exist
- "Waiting on you" subset is specific and actionable
- Sent as ONE Telegram message

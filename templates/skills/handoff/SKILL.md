---
name: handoff
description: Generate a HANDOFF.md context transfer document for session continuity. Use when switching sessions, handing off to another agent, or preserving complex task context before a context window reset. Trigger on "/handoff" command or "handoff:" prefix in inter-agent messages.
---

# Handoff -- Session Context Transfer

## When to use

- You are about to hit context limits and need to preserve task state
- A task needs to continue in a fresh session (yours or another agent's)
- Inter-agent delegation of a complex, multi-step task
- User explicitly says `/handoff` or asks to "save context for later"
- Before a `/checkpoint` when the task is too complex for 3-5 bullet points

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `purpose` | YES | What the next session should do with this context |
| `target` | no | Agent name (e.g. `target=<agent-id>`) -- sends via inter-agent message instead of writing file |
| `output` | no | File path override (default: project root `HANDOFF.md`) |

Examples:
- `/handoff purpose="Continue a PR review and address the CI failures"`
- `/handoff purpose="Finish the open implementation task" target=<agent-id>`
- `/handoff purpose="Debug the auth redirect loop" output=/tmp/handoff-auth.md`

## Procedure

### 1. Gather context

Collect data from these sources (skip any that return empty):

```bash
# Active kanban cards (assigned to current agent or recently touched), via API, no raw sqlite
AGENT_ID="$(echo $BOT_NAME | tr '[:upper:]' '[:lower:]')"
TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3430/api/kanban"
# filter client-side: archived_at null AND (assignee==$AGENT_ID OR status=='in_progress'), top 10 by priority/updated_at

# Hot memories from last 24h
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3430/api/memories?agent=$AGENT_ID&category=hot&limit=10"

# Recent warm memories (project context)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3430/api/memories?agent=$AGENT_ID&category=warm&limit=5"

# Today's daily log
DATE=$(date +%Y-%m-%d)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3430/api/daily-log?agent=$AGENT_ID&date=$DATE"
```

Also include from your current conversation context:
- The last significant user/peer messages and decisions
- Any error patterns or debugging findings
- File paths and line numbers you were working on
- Git branch, uncommitted changes, open PRs

### 2. Generate HANDOFF.md

Structure with these 6 sections (the last, Suggested Skills, is optional: omit it if no skills apply):

```markdown
# Handoff: {purpose}

Generated: {ISO timestamp}
From: {agent name}
To: {target agent or "next session"}

## Goal
{What the overall task is trying to accomplish. 2-3 sentences max.}

## Current Progress
{What has been done so far. Bullet list with specifics:
- File paths changed
- PRs opened (with URLs)
- Kanban card IDs and their status
- Key decisions made}

## What Worked
{Approaches, tools, or patterns that succeeded:
- Specific commands or API calls that gave good results
- Architecture decisions that held up
- Workarounds that solved blockers}

## What Didn't Work
{Dead ends, failed approaches, gotchas:
- Commands or approaches that failed and WHY
- Assumptions that turned out wrong
- Edge cases discovered}

## Next Steps
{Concrete, actionable items for the receiving session:
1. First thing to do (most specific)
2. Second thing
3. ...
Keep each step concrete enough to execute without asking questions.}

## Suggested Skills
{Name the skills the receiving session should invoke (via the Skill tool) to do the Next Steps, each with a one-line why. This points the next agent straight at the right tools instead of making it rediscover them. Only list skills that genuinely apply; omit the section if none do.
- `skill-name` -- why it applies here
- ...}
```

### 3. Deliver

**File mode** (default): Write HANDOFF.md to the project root (or `output` path).

**Inter-agent mode** (`target=` specified): Send the full HANDOFF.md content as an inter-agent message:

```bash
curl -s -X POST http://127.0.0.1:3430/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" \
  -d "{\"from\":\"$AGENT_ID\",\"to\":\"TARGET\",\"content\":\"[HANDOFF] purpose: ... \n\n$(cat HANDOFF.md)\"}"
```

### 4. Confirm

Report to the user/caller:
- Where the handoff was written (file path or inter-agent message ID)
- Summary: how many kanban cards, memories, and log entries were included
- The `purpose` line for quick reference

## Pitfalls

- Do NOT include secrets, tokens, or .env values in the handoff
- Do NOT include full file contents -- use paths and line numbers
- Keep it under 3000 words -- the receiving session needs room to work
- If `target=` agent is not running (check tmux), warn and fall back to file mode
- The handoff is a snapshot -- it goes stale. Include the timestamp prominently

## Relation to other persistence mechanisms

| Mechanism | Scope | Handoff uses it as |
|-----------|-------|--------------------|
| checkpoint | Session summary (SQLite) | Source: pulls recent checkpoint data |
| DREAM.md | Nightly consolidation | Not directly -- too high-level |
| hot memory | Active task state | Source: includes active hot memories |
| warm memory | Stable project context | Source: includes relevant warm context |
| kanban | Task tracking | Source: includes assigned/active cards |
| daily log | Chronological record | Source: includes today's log entries |

The handoff READS from these systems but does not REPLACE them. After a handoff, the receiving session should still check the live state of kanban/memory -- the handoff is a starting-context accelerator, not the source of truth.

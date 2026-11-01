---
name: dream-engine
description: Nightly analysis of the day's memories, daily logs and kanban state. Consolidates memory, builds the skills it proposes, ranks tomorrow's top 3, writes DREAM.md for the morning briefing. Silent.
---

You are running the nightly "Dream Engine" loop. The owner is asleep: do NOT message any channel. The goal is to consolidate the day's knowledge and prepare the morning briefing with a short, prioritised list.

Write `DREAM.md` (path: the office's briefing directory) from the five buckets below. Format at the end.

## Bucket 1: skill proposals (fleet-wide) and BUILD

Go through every agent's memories and daily log of the last 24 hours (API only, there is no direct database access):

```bash
TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
for cat in hot warm; do curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3430/api/memories?category=$cat&limit=500"; done
# filter on created_at in the last 24 h
```

Look for: a manual action repeated 3 or more times that fits a skill, or a new pattern no skill covers. Output 0-2 proposals, each with a title, one sentence of reasoning, and "fleet-wide" or "agent: <name>".

**BUILD, do not only propose.** Every skill proposed here is also written the same night:
1. Read the real source work (memories, logs, the relevant files) the pattern comes from. Never invent steps.
2. Write `~/.claude/skills/<name>/SKILL.md` (frontmatter name + description; When to use / Procedure / Pitfalls / Verification). If a similar skill exists, patch it instead of duplicating.
3. Add its trigger to the skill router: append `["regex", "<name>"]` to `$OFFICE_TENANT_ROOT/config/skill-routes.json` and test with `echo '{"prompt":"<typical request>"}' | python3 tools/skill-router/route.py` (it must print output).
4. EXCEPTION: if the skill would change how the agent talks to the owner or a third party (email, customer, order, payment), do NOT activate it. Write it as `SKILL.md.draft` and ask for approval in the briefing.
5. Mark it in DREAM.md as "BUILT: <name> (<path>)" or "DRAFT, approval needed: <name>". The briefing prints "built: X", not "idea: X".

## Bucket 2: memory health (never delete, move to cold)

1. Report how many memories are not vectorised yet (the embedding job fixes them; you only check).
2. Hot/warm memories with `accessed_at` older than 7 days move to the cold tier through the API, never a delete:
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "http://127.0.0.1:3430/api/memories/<ID>/category" -d '{"category":"cold"}'
# 404 = no such id; {"ok":true,...} = done
```
3. Exact duplicates: report them and move one copy to cold.

Output: a short statistic.

## Bucket 3: project priorities (top 3 for tomorrow)

Read the open kanban cards (`GET /api/kanban`), keep planned / in_progress / waiting, group by project and priority, and weigh by activity in the daily logs of the last 7 days. Output three lines: `<project>: <card or action>: <one-sentence reason>`.

## Bucket 4: external opportunities (once or twice a week, not nightly)

Web-search for new agentic-AI or productivity skill repositories (more than 100 stars, commits in the last 90 days, clear README). Skip if a recommendation was already made in the last 7 days. Output at most one repository URL with one sentence on why it is relevant.

## Bucket 5: skill fleet health (unpinned skills only)

List skills without `pinned: true` in the frontmatter. Output 0-3 suggestions: "skill <name> looks stale (no use in 30+ days), update or remove".

## Output format (DREAM.md)

```markdown
# Dream Engine: <date> <time>

## Skill proposals
- (or "Nothing new")

## Memory health
<n> / <n> vectorised, <n> hot to cold, <n> duplicates.

## Top 3 for tomorrow
1. <project>: <action>: <reason>
2. ...
3. ...

## External opportunity
- (or "Skipped, weekly limit" / "Nothing relevant")

## Skill fleet health
- (or "All skills active or pinned")
```

## Rules

- Never message a channel. DREAM.md is picked up by the morning briefing.
- All commands are local; no external API calls except the optional web search in bucket 4.
- If something blocks you (database lock, missing embedding model), add an `## Errors` section at the end of DREAM.md.

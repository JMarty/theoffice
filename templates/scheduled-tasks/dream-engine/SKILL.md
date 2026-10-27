---
name: dream-engine
description: Nightly "dream" (05:00, before the morning briefing) - consolidate the fleet's memory, retire stale hot memories to cold (never delete), rank tomorrow's top 3, and write DREAM.md for the briefing. Silent.
---

# Dream Engine (nightly, silent)

You are running the nightly Dream Engine. The operator is asleep: **do NOT message anyone.** The only
output is one file, `$OFFICE_TENANT_ROOT/DREAM.md`, overwritten each night. The morning briefing reads it
and passes on only what matters.

*Set up*

    TOKEN=$(cat "$OFFICE_TENANT_ROOT/store/.dashboard-token")
    API=http://127.0.0.1:${OFFICE_PORT:-3430}/api
    curl -s -H "Authorization: Bearer $TOKEN" "$API/agents"     # the fleet
    date                                                         # local time, use it for every "24h" / "7 days"

Use the runtime API for every read and write. **Never touch the SQLite files directly** (the runtime is the
only DB authority; a direct write can land in the wrong database and nobody notices).

## Bucket 1 - Skill ideas (fleet-wide)

Read every agent's memories and daily logs from the last 24h:

    for c in hot warm; do curl -s -H "Authorization: Bearer $TOKEN" "$API/memories?category=$c&limit=500"; done
    curl -s -H "Authorization: Bearer $TOKEN" "$API/daily-logs?limit=200"

Filter on `created_at` to the last 24h. Look for a manual job done 3+ times, or a new pattern no existing
skill covers. Output 0-2 ideas: title + one-sentence reason + "fleet-wide" or "agent: <id>".

## Bucket 2 - Memory health (move to cold, NEVER delete)

From the same hot list, find memories with `accessed_at` older than 7 days, and exact duplicate `content`
(keep the newest, retire the rest). Move each to cold:

    curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      "$API/memories/<ID>/category" -d '{"category":"cold"}'
    # {"ok":true,...} = moved; 404 = no such id

Cold is still searchable, so nothing is lost. Also count memories without an embedding (the embedding job
fills them itself; you only report the number). Output one line of counts.

If the operator has said tier changes need their approval, do not move anything: list the ids in DREAM.md
and ask once in the briefing instead.

## Bucket 3 - Top 3 for today

    curl -s -H "Authorization: Bearer $TOKEN" "$API/kanban"

Take cards in planned / in_progress / waiting, group by project, weigh priority against movement in the
last 7 days of daily logs (and `$OFFICE_TENANT_ROOT/GOALS.md` if present). Output exactly 3 lines:
`<project>: <card / action> - <one-sentence reason>`.

## Bucket 4 - External opportunity (weekly only)

Skip unless the marker `$OFFICE_TENANT_ROOT/scheduled-tasks/dream-engine/.external-last-run` is missing or
older than 7 days. Then web-search for one new Claude Code / agentic skill repo (100+ stars, commits in the
last 90 days, clear README) relevant to this operator, and touch the marker. Output max 1 line: URL + why.

## Bucket 5 - Skill health (weekly only, same marker day)

List skills under `~/.claude/skills/` with no `pinned: true` in their frontmatter that look unused for 30+
days. Output 0-3 lines: "skill <name>: unused 30+ days, update or remove?". Never delete a skill yourself.

## DREAM.md format

    # Dream Engine - YYYY-MM-DD HH:MM

    ## Skill ideas
    - ... (or "No new ideas")

    ## Memory health
    N / N vectorised, X hot->cold, Y duplicates retired.

    ## Top 3 for today
    1. ...
    2. ...
    3. ...

    ## External opportunity
    - ... (or "Skip - weekly")

    ## Skill health
    - ... (or "All skills active or pinned")

    ## Errors
    - only if something failed (API down, 4xx/5xx, missing token). Never hide a failure.

## Rules

- Silent. No office-say, no bus message. DREAM.md is the whole output.
- Never delete a memory, a card or a skill. Moving to cold is the strongest action allowed.
- The morning briefing should read `$OFFICE_TENANT_ROOT/DREAM.md` and include the Top 3 plus anything that
  needs the operator. If your briefing task does not read it yet, add that line to the briefing task.

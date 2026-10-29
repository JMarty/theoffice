---
name: kanban-audit
description: Kanban board audit every 4 hours. Cleanup (archive done cards older than 7 days) + chasing stuck tasks (in_progress not moved since the previous audit -> ping the assignee).
---

# Kanban 4-hour audit

## When it runs
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonomy level (config-driven, MANDATORY FIRST)

Read it: `jq -r '.categories[]|select(.key=="kanban_archive_done" or .key=="kanban_stuck_nudge")|"\(.key) \(.level)"' $OFFICE_TENANT_ROOT/store/autonomy-config.json`

The levels of the two categories govern steps 2 and 4:
- **`kanban_archive_done`** (step 2): level 3 → archive on your own (default). level 2 → do NOT archive, propose it on Telegram ("X done cards older than 7 days are waiting to be archived, go ahead?") and wait for approval. level 1 → just report the number.
- **`kanban_stuck_nudge`** (step 4): level 3 → ping the assignee yourself, and escalate to the owner's lead ONLY after 2 unsuccessful audit rounds (the comment history shows how often you pinged). level 2 → do not ping yourself, propose it to the lead in chat. level 1 → just list the stuck tasks.

If the config is missing or the key is not in it → default level 3 (old behavior).

## Procedure

1. **Read the state file**: `store/kanban-audit-state.json` holds the `last_audit_at` Unix timestamp. On the first run it is null -> ping nobody, just set the state.

2. **Cleanup**: archive done cards older than 7 days, through the API (NO direct sqlite, so you physically cannot write to the wrong DB):
   ```bash
   TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
   # fetch the done cards, then filter client-side for updated_at < (now - 7 days):
   curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3430/api/kanban?status=done"
   # archive each such id:
   curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3430/api/kanban/<ID>/archive"
   # 404 = no such id (a real success signal); {"ok":true,"id":...} = archived
   ```

3. **Stuck task detection** (not moved since the previous audit): in_progress cards with `updated_at < last_audit_at`:
   ```bash
   TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
   LAST=$(jq -r .last_audit_at store/kanban-audit-state.json 2>/dev/null || echo 0)
   curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3430/api/kanban?status=in_progress"
   # filter updated_at < $LAST; hours_stale = (now - updated_at)/3600
   ```

4. **Stuck task -> ping**: for every stuck card send an inter-agent message to the assignee (except the main agent and an empty assignee):
   ```
   "Kanban-audit: {card_id} ({title}) has been in_progress for {hours_stale}h without movement (since the previous audit). Update the status (done/waiting) or leave a comment on what is blocking it."
   ```

5. **Update the state file** (at the END of the run): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Unassigned cards**: in_progress/waiting/planned cards whose assignee is NULL/empty -> log + Telegram only if there are 3+ of them.

7. **Write on Telegram only if**:
   - there are 3+ stuck tasks (critical)
   - there is a new blocker (waiting > 48h)
   - otherwise stay quiet (heartbeat style)

## Pitfalls
- The "not moved since the previous audit" condition means `updated_at < last_audit_at`. Do NOT use an absolute 24h threshold.
- Do not archive done cards if < 7 days old (the user still wants to see them).
- Do NOT ping yourself (skip if assignee='<agent-id>').
- Do not re-ping the same one within 4 hours: the `last_audit_at` stored in the state file handles this automatically.
- On the first run (state file empty) -> do not ping, just initialize the state.
- A status change (in_progress -> done) also updates updated_at, so the next audit will not catch tasks that are still active now.
- **jq is not installed on the server** — use `python3 -c "import json; print(json.load(open('store/kanban-audit-state.json'))['last_audit_at'])"` for reading and writing the state. Lesson from 2026-05-28.
- **"Stuck" != actually stuck**: if the card's `updated_at` is old BUT the assignee reported status that morning (e.g. a morning-briefing agent-status ping) and it turned out they are waiting on the Owner (waiting on you), the card is not "stuck", just $USER-blocked. Do NOT send a redundant audit ping to the assignees in that case — they already signaled, they just did not update the metadata. Update the state file and move on. Cross-check: all 7 stuck cards were $USER-blocked at the 2026-05-28 12:00 audit, it would have been ping spam.

## Verification
- The state file was updated at the end of the run.
- Inter-agent messages succeeded (200 response).

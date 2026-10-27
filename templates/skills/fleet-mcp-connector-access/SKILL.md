---
name: fleet-mcp-connector-access
description: Grant or deny a claude.ai MCP connector (Grocery, Gmail, Drive, Calendar, Slack, Notion, etc.) to specific marveen fleet agents. Use when Owner says "give agent X access to Y MCP", "agent X should/shouldn't have Y", or "make X aware of Y connector".
---
# Fleet MCP connector access

## When to use
- Owner wants one or more fleet agents to gain/lose access to a claude.ai connector (mcp__claude_ai_*).
- "Make the home agent aware of the Grocery connector", "the finance agent needs spend data", "the outward agent must not touch my Gmail".

## Key facts
- claude.ai connectors are INHERITED by every agent via the shared owner OAuth. Access is the DEFAULT.
- Restriction = a `deny` glob (e.g. `mcp__claude_ai_<Connector>__*`) in the agent's permissions.
- An agent's `agents/<name>/.claude/settings.json` `permissions` block is REGENERATED from its security profile on EVERY `/api/agents/<a>/start`. Manual deny edits there get WIPED on next start.
- Durable source of truth for permissions = the profile template `templates/profiles/<profile>.json` (`filesystem.deny`).
- Hooks, enabledPlugins, and CLAUDE.md are NOT touched by profile re-apply (survive restart).
- Check an agent's profile: `curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/agents` -> field `securityProfile`.

## Procedure
### To GRANT (make aware + usable)
1. Access already works by default (no deny). Confirm the agent has no deny glob for that connector.
2. Make the agent AWARE: add a role-tailored section to `agents/<name>/CLAUDE.md` describing the connector, the useful tools, and guard rails (e.g. "add-to-cart OK, never checkout without explicit go-ahead").
3. If agent is running, it picks up CLAUDE.md on next start; restart only if it must be aware immediately.

### To DENY durably
1. Find the agent's profile (API `securityProfile`).
2. If the profile is shared/appropriate (e.g. `restricted-no-user-google` for outward agents) and ALL its users should lose the connector: add `mcp__claude_ai_<Name>__*` to `templates/profiles/<profile>.json` `filesystem.deny`.
3. If the agent is on `default` (shared by many who NEED access): do NOT edit default. Create/assign a dedicated restricted profile for that agent instead, or leave it (no instruction = won't use).
4. Restart the agent so settings.json regenerates from the updated template:
   `curl -s -X POST -H "Authorization: Bearer $TOKEN" .../api/agents/<a>/stop` then `/start`.
5. Verify: `python3 -c "import json;print(json.load(open('agents/<a>/.claude/settings.json'))['permissions']['deny'])"`

## Pitfalls
- Editing `agents/<a>/.claude/settings.json` deny directly does NOT persist — startup overwrites it from the profile. Always edit the profile template for durable denies.
- Don't add a deny to `default` profile to block one agent — it blocks every default-profile agent. Use a dedicated profile.
- After any agent (re)start, CLEAR the Remote Control modal or the agent is alive but frozen/deaf: capture last 3 non-empty pane lines (`tmux capture-pane -p -t agent-<a> | grep -v '^$' | tail -3`); if it shows "Enter to select"/"❯ Continue", `tmux send-keys -t agent-<a> Enter` (may need 2 passes).

## Verification
- GRANT: connector section present in CLAUDE.md; no deny glob for it.
- DENY: regenerated settings.json deny array contains the glob AFTER a stop/start cycle (not just a manual edit).

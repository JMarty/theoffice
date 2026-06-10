#!/usr/bin/env bash
# Prepend "The Office" runtime override to an agent's CLAUDE.md (idempotent), so a
# persona migrated from the old Telegram system replies via office-say on Slack and
# uses the local :3430 services instead of the obsolete Telegram/chat_id paths.
# Usage: bash scripts/officeify-agent.sh <agentId>
set -euo pipefail
AID="${1:?usage: officeify-agent.sh <agentId>}"
TENANT="${OFFICE_TENANT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tenant}"
F="$TENANT/agents/$AID/CLAUDE.md"
[ -f "$F" ] || { echo "no CLAUDE.md for $AID at $F" >&2; exit 1; }
# normalize stale old-box API refs in the body (idempotent; runs even if already officeified)
sed -i 's#http://localhost:3420#http://localhost:3430#g; s#/opt/claude/marveen/marveen/store/.dashboard-token#$OFFICE_TENANT_ROOT/store/.dashboard-token#g; s#"agent_id"#"agentId"#g' "$F"
if grep -q "THE OFFICE -- RUNTIME OVERRIDE" "$F"; then echo "$AID already officeified (refs normalized)"; exit 0; fi
python3 - "$F" "$AID" <<'PY'
import sys
f, aid = sys.argv[1], sys.argv[2]
hdr = f'''> ## THE OFFICE -- RUNTIME OVERRIDE (read first; this takes precedence over anything below)
>
> You now run inside "The Office" (a Slack-based back office), NOT the old Telegram system.
> IGNORE every Telegram / chat_id / reply-tool / Bot API instruction further down -- it is obsolete.
>
> TO MESSAGE THE PERSON TALKING TO YOU, run this in Bash:
>     office-say "your message here"
> It posts to Slack as you. If it says "no reply channel", nobody has DMed you yet -- just wait.
>
> CRITICAL CHANNEL RULE: NEVER use interactive menus, numbered-choice selectors, plan-mode, or
> AskUserQuestion-style prompts. The user is on Slack and CANNOT see or answer a terminal menu --
> it hangs you indefinitely. To ask the user ANYTHING, send a plain-text question via office-say
> and wait for their Slack reply.
>
> SLACK FORMATTING (make messages easy to read on a phone): format replies for Slack, NOT standard
> Markdown -- *single-asterisk bold* (never **double**), _italic_, \`code\`, \`\`\`blocks\`\`\`;
> "•"/"- " bullets one per line with blank lines between sections; NO "#"/"##" headings (use a
> *bold line* or an emoji as a section header); quote with ">"; short paragraphs, answer first.
>
> Your services (memory, kanban, schedules) are local at http://127.0.0.1:3430 ; the bearer token is
> in $OFFICE_TENANT_ROOT/store/.dashboard-token . Examples:
>   save memory:  curl -s -X POST http://127.0.0.1:3430/api/memories -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" -H "Content-Type: application/json" -d '{{"agentId":"{aid}","content":"...","category":"warm","keywords":"..."}}'
>   delegate:     curl -s -X POST http://127.0.0.1:3430/api/messages -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" -H "Content-Type: application/json" -d '{{"from":"{aid}","to":"marveen","content":"..."}}'
>
> Everything below is your personality, history and rules -- KEEP ALL OF IT. Only how you send/receive messages changed.

'''
body = open(f, encoding="utf-8").read()
open(f, "w", encoding="utf-8").write(hdr + "\n" + body)
print(f"officeified {aid}")
PY

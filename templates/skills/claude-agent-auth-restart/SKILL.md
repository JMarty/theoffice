---
name: claude-agent-auth-restart
description: Recover Office fleet Claude agents after owner reauth succeeds but resident tmux panes still return 401 Invalid authentication credentials.
---

# Claude Agent Auth Restart

## When to use
- An Office fleet agent pane shows `Please run /login` or `401 Invalid authentication credentials`.
- `claude auth status` already reports a valid `claude.ai` login.
- The affected agents are resident Claude runtime sessions in `tmux -L theoffice`.

## Procedure
1. Check current time and auth:
   ```bash
   date
   claude auth status
   stat -c '%y %n' ~/.claude/.credentials.json
   python3 - <<'PY'
   import json, time, datetime
   p='/home/<user>/.claude/.credentials.json'
   d=json.load(open(p)); o=d.get('claudeAiOauth',{})
   print('expiresAt', datetime.datetime.fromtimestamp(o.get('expiresAt',0)/1000, datetime.UTC).isoformat())
   print('now', datetime.datetime.fromtimestamp(time.time(), datetime.UTC).isoformat())
   print('refreshToken_len', len(o.get('refreshToken') or ''))
   PY
   ```
2. Capture the affected panes:
   ```bash
   tmux -L theoffice capture-pane -pt agent-AGENT:0.0 -S -80
   ```
3. Restart through the dashboard API so the engine kills and relaunches the session cleanly:
   ```bash
   TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
   curl -s -X POST "http://127.0.0.1:3430/api/agents/AGENT/restart" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json"
   ```
4. Verify health:
   ```bash
   TOKEN=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3430/api/agents > /tmp/agents.json
   python3 - <<'PY'
   import json
   for a in json.load(open('/tmp/agents.json')):
       if a["id"] in ("marveen", "darryl"):
           print(a["id"], a["running"], a["state"], a["model"], a["runtime"], a["slack"]["ready"] if a["slack"] else None)
   PY
   ```
5. Re-capture panes. They should show a fresh Claude Code prompt with the expected model and no 401.

## Pitfalls
- A successful disk reauth does not fix already-running Claude TUI processes. Restart resident panes so they reload `~/.claude/.credentials.json`.
- `claude auth status` can still say logged in while the actual credential is unusable for the TUI. Verify `~/.claude/.credentials.json`: `expiresAt` must be in the future and `refreshToken_len` should be nonzero after a good Claude.ai login.
- Prompts submitted to a broken pane may be marked `delivered` by the queue because delivery only means the text reached the TUI. They will not be replayed automatically after restart.
- If the owner sends the fresh login code while the current Pete/Codex run is still active, consume it in the active login session and mark that queued inbound row delivered, otherwise Pete will get a stale "here is the code" task right after the repair.
- Use `marveen` as the agent id for Michael.
- Do not paste auth codes into logs or final replies.

## Verification
- `claude auth status` is logged in.
- Dashboard `/api/agents` reports affected agents as `running=true`, `state=idle`, `runtime=claude`.
- Pane capture shows the fresh Claude prompt, not the prior API auth error.

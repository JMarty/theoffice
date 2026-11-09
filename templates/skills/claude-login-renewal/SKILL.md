---
name: claude-login-renewal
description: Renew the fleet's shared Claude login (~/.claude/.credentials.json, Max) before its refresh token expires (~30-day life; current one expires 2026-11-10 18:08, reminder task claude-login-renewal-nov fires Sat 7 Nov 20:00). Back up the credential, start `claude auth login`, give the owner the sign-in link, take his pasted CODE#STATE, verify the new expiry, check the panes, arm the next reminder. Use when that reminder fires, when /api/auth/health says refreshExpiringSoon, or when he says "renew the Claude login".
---

# Fleet Claude login renewal

All resident agents share ONE credential file. If its refresh token lapses, every agent goes silent at
once (2026-06-25 outage). Renewal is a CLI OAuth (PKCE) flow that needs the owner for one tap + one paste.
Sources: task `/opt/claude/theoffice/tenant/scheduled-tasks/claude-login-renewal-nov/SKILL.md`
(the 2026-10-11 procedure that worked), memories 4247 + 4248 (2026-08-21), engine
`/opt/claude/theoffice/src/web/server.ts` (`/api/auth/*` routes).

## Mikor használd
- The renewal reminder task fires (next: `claude-login-renewal-nov`, Sat 2026-11-07 20:00, one-off).
- `GET /api/auth/health` shows `credential.refreshExpiringSoon: true` or the dashboard banner nags.
- He asks to renew / re-login Claude.
- NOT for panes still 401 after a successful renewal: that is `claude-agent-auth-restart`.

## Eljárás
1. Ground truth first (memory 4248: never act on memory or a reminder text alone):
   ```bash
   date
   TOKEN=$(cat /opt/claude/theoffice/tenant/store/.dashboard-token)
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3430/api/auth/health \
     | python3 -I -c "import json,sys,datetime as d;j=json.load(sys.stdin);c=j['credential'];print(j['status'],'refresh until',d.datetime.fromtimestamp(c['refreshExpiresAt']/1000),'soon',c['refreshExpiringSoon'],'login',j.get('login',{}).get('phase'))"
   ```
   Same numbers live in `~/.claude/.credentials.json` -> `claudeAiOauth.refreshTokenExpiresAt` (ms).
   If it is already ~30 days out (he renewed via the dashboard banner himself), say so in one line and stop.
2. Back up the credential (never print it):
   `cp -p ~/.claude/.credentials.json ~/.claude/.credentials.json.bak-$(date +%Y%m%d-%H%M) && chmod 600 ~/.claude/.credentials.json.bak-*`
3. Start the login. Two real paths; use ONE:
   - *A. tmux (worked 2026-10-11):*
     `tmux new-session -d -s claude-login "BROWSER=echo claude auth login --claudeai; sleep 600"`
     then `tmux capture-pane -pt claude-login -S -40` and take the authorize URL
     (`https://claude.com/cai/oauth/authorize?...code_challenge=...&state=...`; it can wrap over lines:
     join them).
   - *B. dashboard API (engine route, used 2026-08-21 through the banner):*
     `POST /api/auth/login/start` (bearer) returns the browser URL; it runs the same `claude auth login`
     in a tmux session. (verify) the response field name before relying on it.
4. office-say him the link, short, as a plain URL (not a dashboard domain, memory 4247): open, approve,
   copy the code shown, paste it back here. Warn nothing else; it is a 30-second job.
5. His reply is a code shaped `<code>#<state>`. It LOOKS like random characters: that is correct, never
   call it corrupted or ask him to resend it (2026-08-21 owner correction, memory 4248).
   - Path A: `tmux send-keys -t claude-login '<CODE#STATE>' Enter`, then capture the pane: expect
     `Login successful.`
   - Path B: `POST /api/auth/login/code {"code":"<CODE#STATE>"}`; on success it also restarts signed-out
     panes (`restart:false` to skip).
   Never echo the code into logs, memory, Slack or the final reply.
6. Verify (step 1 again): `refreshExpiresAt` moved ~30 days ahead, `status` healthy, credential mtime =
   just now. Then `tmux kill-session -t claude-login` (path A).
7. Panes: in the same health output every agent must be `signedOut: false`. Any 401 / "Please run /login"
   pane -> follow `claude-agent-auth-restart` (restart through `/api/agents/<id>/restart`).
8. Close the loop:
   - office-say him one line: renewed, good until <date HH:MM>.
   - Set the fired one-off task `enabled=false` (its own instruction).
   - Arm the next one-off reminder ~3 days before the new expiry (precedent: the Nov task was created
     2026-10-12, the day after the 10-11 renewal) in `/opt/claude/theoffice/tenant/scheduled-tasks/<name>/`
     with SKILL.md + task-config.json (`"type":"task","agent":"marveen","enabled":true`, cron in Budapest
     time). Point it at this skill. Read it back (memory: enabled is not armed).
   - Save a warm memory: renewed at, new expiry, reminder name.

## Buktatók
- Never refresh the OAuth token ourselves with the refresh token (memory 6632). Only the interactive login.
- Do not run any of this as root / with sudo (the office runs everything as the service user).
- The authorize URL is single-use and tied to the waiting process: if the tmux session died (sleep 600 =
  10 minutes) before he pasted, start a new one and send a new link; say why in one line.
- `claude auth status` can say "logged in" while the credential is unusable for the TUI; trust the
  health endpoint + `refreshTokenExpiresAt`, not the status line.
- The banner on a hosted app only appears where the same flow is HOSTED; check the login flow itself, not the banner.
  used it, step 1 shows it and you stop.
- A code he pastes while another session is mid-login must go to THAT login session (see
  claude-agent-auth-restart Buktatók); do not start a second login.
- A reminder written today rots: re-check the expiry when it fires, the date in the task text may be stale.

## Ellenőrzés
- `/api/auth/health`: status healthy, refreshExpiresAt ~30 days out, refreshExpired false, no agent signedOut.
- Backup file exists next to the credential, mode 600.
- tmux session `claude-login` gone.
- Fired task disabled, next reminder exists with enabled=true and the right cron (read back from disk).
- Owner got exactly one office-say with the new expiry.

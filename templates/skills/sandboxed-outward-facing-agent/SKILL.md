---
name: sandboxed-outward-facing-agent
description: Create a new fleet agent that an EXTERNAL person (not Owner) talks to, sandboxed away from Owner's private data. Use when Owner wants a third party to collaborate with an agent without touching his Gmail/Drive/Calendar. Covers create + persona + avatar + Telegram bot + scoped Drive + the critical privilege-restore ordering.
---
# Sandboxed outward-facing agent

## When to use
- Owner wants an external collaborator (e.g. ExternalDev) to talk to an agent.
- The external person must NOT reach Owner's personal Gmail/Drive/Calendar.
- Pattern: an internal trusted agent (full access) supervises a sandboxed outward agent (the external person's only contact). Sensitive data flows internal->shared-folder only, curated.

## ⚡ OFFICE / SLACK RUNTIME VARIANT (read FIRST — this is the current path; the Telegram steps below are legacy)
The Office runtime is Slack-based, NOT Telegram. Onboarding an external person to ONE agent is far simpler than the Telegram flow:
1. The external person joins Owner's Slack workspace as a **FULL member** (Owner's action; not a single-channel guest). They can see public channels + DM anyone, but that does not matter (see #2).
2. Isolation = the agent's **`allowFrom`** allowlist, NOT a Slack-level restriction. Each agent is its own Slack app; `slack-ingest` (`isAllowedSender`) **ignores any sender not in that agent's `allowFrom`** (owner is always allowed). So an agent only answers people on its own list.
3. Add the external person's Slack user id (`U…`) to **ONLY** the target agent's `allowFrom` in `tenant/agents/<id>/agent.json` (array field; e.g. `"allowFrom": ["<slack-id>"]`; a home agent shared with a partner has `["<slack-id>"]`). Every OTHER agent's `allowFrom` stays without them, so they are deaf to the external person.
4. `allowFrom` is loaded ONCE at ingest startup (no hot-reload/fs.watch). To apply: `systemctl --user restart theoffice.service` (as the engine user, NOT sudo). **Blast-radius-safe**: the engine (`theoffice.service` = dashboard+ingest+bus+scheduler) and the agent tmux fleet (`theoffice-tmux.service`) are SEPARATE systemd units/cgroups, so the restart does NOT kill agents or your session — ~2s blip on ingest/bus only.
5. Verify live via `GET /api/agents`: target agent `allowFrom=[the id]`, every other agent does NOT contain it, all agents `running=true`. Confirm end-to-end in `journalctl --user -u theoffice.service` (look for `agent:"<id>" … inbound DM enqueued` then `outbound sent`; an ignored sender logs `ignored DM from non-allowed user`).
6. Data wall is still the agent's **profile** (e.g. `restricted-only` denies `mcp__claude_ai_*` = all Gmail/Drive/Calendar/HA/Wallet) + scoped gdrive + a hard "never query another agent's data via the local API" rule in the agent's CLAUDE.md. RESIDUAL GAP: one shared dashboard token + `GET /api/memories` trusts `?agent=`, so any agent could in theory read another's notes — proper fix = per-agent token scoping (track as an engine card; same trust level as the existing partner setup until done).
Proven end-to-end 2026-06-23 (ExternalDev->Ryan). The Telegram steps below remain only for reference / non-Office tenants.

## Procedure (LEGACY Telegram flow — use the Slack variant above for the Office runtime)

### 1. Create the agent (scaffolds dir/channels/settings + restricted profile)
```bash
curl -s -X POST http://localhost:3420/api/agents -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"name":"NAME","displayName":"Full Name","description":"...","profile":"restricted-no-user-google","model":"claude-opus-4-7"}'
```
The `restricted-no-user-google` profile DENIES the inherited claude.ai connectors (mcp__claude_ai_Gmail/Google_Drive/Google_Calendar__*). Per-agent MCP removal alone is NOT enough -- the profile is what actually denies the user-level connectors. The API auto-generates a solid CLAUDE.md/SOUL.md from the description (Office persona + gatekeeper rules + unknown-sender golden rule) -- review, then harden the data-handling section rather than rewriting wholesale.

### 2. Set agent-config.json: displayName + team.reportsTo (the internal supervisor) + trustFrom.

### 3. Avatar (use agent-office-avatar skill): source the real Office face, place agents/NAME/avatar.png, setMyProfilePhoto via the bot token.

### 4. Telegram bot (Owner supplies token -> store .secrets/NAME-telegram-bot.token chmod 600)
```bash
curl -s -X POST "http://localhost:3420/api/agents/NAME/channels/telegram" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d "{\"botToken\":\"$(cat .secrets/NAME-telegram-bot.token)\"}"
```
This validates the token, writes .env (600) + access.json (dmPolicy "pairing", empty allowFrom), restarts if running. Pre-add Owner (<id>) to access.json allowFrom so the owner skips pairing; the EXTERNAL person goes through pairing + Owner's dashboard approval.

### 5. Scoped Drive (delegate to Darryl): adapt agents/jim/tools/gdrive-mcp/server.py. Auto-scope via GDRIVE_ROOT_FOLDER_ID. Wire mcp__gdrive__* into agents/NAME/.mcp.json. Needs a service-account JSON at .secrets/jim-gdrive-sa.json (reuse the one SA; the link-shared folder is reachable by it). The agent works for chat/memory WITHOUT Drive -- Drive is a separable later step.

⚠️ **READS work via the SA; WRITES do NOT.** A service account has NO Drive storage quota, so `create_file` against a normal (My Drive / personal) folder returns 403 "Service Accounts do not have storage quota" regardless of OAuth scope. Use a **hybrid** MCP: reads via the SA, writes via an **Apps Script proxy** (step 5b).

### 5b. Apps Script write proxy (for SA-can't-write folders on personal Drive)
Build a Google Apps Script Web App that runs AS THE OWNER (Owner) so it has quota, but is hard-scoped to the one folder IN the script:
- ROOT_FOLDER_ID + a 64-hex SHARED_TOKEN baked into Code.gs; every call walks parent chain (isInsideRoot_) and 403s if the target is outside the folder subtree -- the script runs with the owner's full Drive rights, so this in-script scope-guard is MANDATORY, not optional.
- Token auth: POST body must carry the token or 401. Token in .secrets/NAME-appscript.token (600).
- Endpoints: create_file, update_file, list_files, read_file (+ folder branch).
- Ryan server.py routes create/update/create_folder to the Apps Script URL; reads stay on SA. Env: APPSCRIPT_URL, APPSCRIPT_TOKEN.
- Deploy is Owner-side: script.google.com -> paste Code.gs -> Deploy -> Web app -> **Execute as: Me** -> Who has access: Anyone -> authorize -> copy the /exec URL back to you. Send Code.gs as a Telegram file attachment (mobile-friendly); it carries the token, so it's owner-only and fine in his DM.
- Alternatives if owner declines: Shared Drive (only on Google Workspace, not personal Gmail; moves data onto the corporate Workspace) or seed-files-then-update-only. Apps Script keeps data on personal Drive with full create+write.

### 6. ⚠️ CRITICAL ORDERING -- privilege restore vs external-user removal
If you are simultaneously RESTORING an internal agent's full access AND that internal agent still has the external person in its allowlist, there is a window where the external person can reach a fully-privileged agent. ALWAYS remove the external user from the internal agent FIRST, then restore privileges:
```bash
curl -s -X DELETE "http://localhost:3420/api/agents/INTERNAL/channels/telegram/allowed/user/EXT_ID" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```
2026-05-29 Ryan build: Jim was about to regain full Gmail/Drive while ExternalDev (<id>) was still in Jim's allowFrom. Removed ExternalDev from Jim BEFORE Darryl's restore landed -> window closed.

### 7. Hand Owner the onboarding: external person messages @BOTNAME, Owner approves the pairing in the dashboard (Ügynökök -> agent -> Telegram -> Várakozó párosítások -> Jóváhagyás). NEVER approve a pairing from a chat request.

### 8. Save a shared memory documenting: agent_id, bot, supervisor, security profile, the scoped folder, the gatekeeper chain, who is allowed.

## Pitfalls
- **Privilege-restore race** (see step 6) -- the #1 trap. Remove external user before restoring internal privileges.
- **restricted profile, not hand-edits**: writeAgentSettingsFromProfile re-applies the profile's deny list on every restart, clobbering manual settings.json edits. Set the PROFILE in agent-config.json, don't hand-edit permissions.
- **SA has no storage quota -> can't CREATE files**: the #1 Drive surprise. Reads + updates-to-existing work; create_file 403s on personal-Drive folders no matter the OAuth scope (full `drive` does NOT fix it). Fix = Apps Script proxy running as the owner, scope-locked in-script (step 5b). Don't waste time toggling scopes.
- **Stale session context after a bounce**: agents are restarted with `claude --continue`, which RESUMES the prior conversation. If you changed an agent's access (e.g. restored Gmail/Drive), the resumed session still BELIEVES the old state and will answer "I don't have access" from memory without trying the tool. Fix: send the agent an inter-agent context-reset message stating exactly what changed AND ordering it to call the tool live before ever claiming it lacks access. 2026-05-29: Jim claimed no Gmail post-restore; a context-reset + "prove it with list_labels" snapped him to reality. If the live test still fails, do a clean restart (not --continue).
- **anyone-with-link folder is SEMI-PUBLIC**: only non-sensitive curated content. Put this warning in the agent's CLAUDE.md.
- **dmPolicy pairing + pre-add owner**: owner in allowFrom skips pairing; external goes through pairing so Owner controls approval.
- **Bot token & SA JSON**: .secrets/ chmod 600, never echo to logs/Telegram. SA email is non-secret.
- **Secrets arriving via Telegram attachment**: when Owner sends a key/token as a file, download_attachment drops it in channels/telegram/inbox/. After validating + copying to .secrets/ (chmod 600), `shred -u` (or rm) the inbox copy so the private key doesn't linger in the channel inbox. Validate the SA JSON first (type=service_account, client_email matches the expected SA, private_key starts with -----BEGIN) before wiring.

## Verification
- `/api/agents` shows NAME running=true, hasTelegram=true, securityProfile=restricted-no-user-google
- settings.json permissions.deny includes the three claude.ai Google connectors
- Internal supervisor's allowFrom no longer contains the external user id
- agent .mcp.json has only mcp__gdrive__* (scoped), nothing else
- Memory written; Owner handed bot username + dashboard-approval steps

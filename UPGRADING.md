# Upgrading

Action-required notes for existing installs. Newest first. After `git pull` (or the
dashboard ⟳ Update button), skim the entries newer than your previous version.

---

## Image & PDF attachments (2026-06-11)

Agents can now **receive image/PDF attachments** you send them on Slack (open them
with their Read tool, e.g. "what's in this screenshot?"). Previously any message
with a file was silently dropped and the agent appeared to go quiet.

**⚠️ ACTION REQUIRED for existing installs** — the code update alone is not enough.
Each agent's Slack app needs two extra bot scopes, because updating the code does
**not** change Slack apps you already created:

1. Open <https://api.slack.com/apps> → pick the agent's app.
2. **OAuth & Permissions → Bot Token Scopes** → add **`files:read`** and **`files:write`**
   (`files:read` = open files you send; `files:write` = send files back).
3. **Reinstall to Workspace** → **Allow**.
4. The bot token (`xoxb-…`) almost always stays the same; if it changed, update
   `tenant/secrets/slack/<agent>.json` and restart the engine
   (`systemctl --user restart theoffice.service`).

Repeat per agent. New agents created via the onboarding wizard get these scopes
automatically (the app manifest now includes them).

Until you add `files:read`, an agent will reply that it can't open the attachment
(rather than going silent) — so nothing breaks, you just won't get image reading
until the scope is added.

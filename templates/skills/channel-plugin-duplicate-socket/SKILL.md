---
name: channel-plugin-duplicate-socket
description: When a new channel plugin (slack-channel, telegram, etc.) is installed in the ClaudeClaw fleet, the user-level ~/.claude/settings.json enabledPlugins makes every agent load the plugin server, and if it opens a Socket Mode connection (Slack), MULTIPLE agents open connections on the same workspace at once. Use it when an agent uses a Socket Mode channel plugin and "half of" the inbound events disappear.
---
# Channel plugin duplicate Socket Mode connection

## When to use
- A new channel plugin (slack-channel, or anything Socket Mode) was installed in the fleet
- An agent (e.g. the Slack agent) uses Slack, and the operator says they are sending DMs but "nothing happens"
- Slack auth.test OK, manifest OK, tokens OK, bot scopes fine, but events do not reach server.ts
- Several claude processes run with the `--channels` flag at the same time in the fleet

## Procedure
1. `ps aux | grep server.ts | grep -v grep` -- count how many slack-channel server.ts processes are running
2. If more than 1 instance: `ps -o pid,ppid,command -p <pid>` for every parent process. The end of the ppid chain should be `claude --continue ... --channels plugin:...`. If the `--channels` flag is NOT the same as the plugin, the plugin was loaded secondarily from `enabledPlugins`.
3. Check the user-level enablement: `grep -A5 enabledPlugins ~/.claude/settings.json`. If the problematic plugin is `true` here, every agent loads it.
4. Override at project level: `<project>/.claude/settings.json` -> `{"enabledPlugins": {"<plugin>@<marketplace>": false}}`. Project > user precedence.
5. In that agent's own project-level settings.json LEAVE it true -- it stays explicitly enabled there.
6. Kill the redundant channel processes (kill <pid>), or restart the tmux session they run in.
7. Verify: `ps aux | grep server.ts | grep -v grep` -- the plugin should run only in the agent-level session.

## Pitfalls
- The Socket Mode bug is SILENT: Slack load-balances two active Socket Mode connections round-robin style, so HALF of the events go to the "non-listening" server.ts and get dropped there. NOT a warning, NOT an error -- just "messages vanish".
- The user-level `~/.claude/settings.json.allowedChannelPlugins` and `enabledPlugins` are *DIFFERENT* things. `allowedChannelPlugins` only whitelists the `--channels plugin:X` flag, but `enabledPlugins.X: true` is what loads the MCP in every agent.
- Because of the fleet architecture (every agent is a claude-code instance) this is not a single-host problem -- every agent opens a Socket independently, and the Slack side cannot tell them apart on one workspace.
- On Telegram it does NOT show up as "events vanish" but as a **lockfight**: the Telegram Bot API is long-poll based, and Telegram locks the session (409 Conflict) if two instances poll -- the two agents kick each other out in turns. Symptom: when agent-X's tmux session restarts, agent-Y's telegram MCP reports "disconnected", and vice versa. **Fix**: in the project-level `.claude/settings.json` of every agent that does NOT communicate over telegram, set `enabledPlugins.telegram@claude-plugins-official: false`. A global `unset TELEGRAM_BOT_TOKEN` in the agent-process.ts launch script is NOT enough, because the telegram plugin also reads from the state-dir `.env` (the SLACK_STATE_DIR env is set, but TELEGRAM_STATE_DIR is not -- so the telegram plugin falls back to the global `~/.claude/channels/telegram/.env`, which holds the orchestrator agent's token).
- **Channel policy is separate from DM policy**: on the slack-channel plugin gate, the DM policy (`access.dmPolicy` + `allowFrom`) and the channel policy (`access.channels[channelId]`) are COMPLETELY separate. An empty `channels: {}` drops every channel message (even @-mentions). Per-channel opt-in: `channels[C...]: {allowFrom: [U...], requireMention: true}`. UX bug source: after setup the user @-tags the bot in a channel and it stays silent, half an hour of debugging. User-friendly solution: have the dashboard poll the journal written to the SLACK_AUDIT_LOG env, build a pending_channel_requests table from gate.inbound.drop entries, and add Approve/Reject buttons on the dashboard.
- **MANAGED allowlist trap (Claude Code 2.1.143)**: `allowedChannelPlugins` is a MANAGED setting (system-level admin policy). On macOS `/Library/Application Support/ClaudeCode/managed-settings.json`. Neither the user-level `~/.claude/settings.json` nor the project-level `.claude/settings.json` is enough -- the tmux pane shows a "plugin:X · not on the approved channels allowlist" warning. The MCP plugin tools are still connected (8 tools), BUT Claude Code disables the `notifications/claude/channel` inbound notification path into the chat. server.ts receives the events (writes to sessions/, smoke test confirms), yet Claude Code swallows them -- the pane stays idle, no `<channel source="slack" ...>` tag appears. Fix: sudo is required to `mkdir -p "/Library/Application Support/ClaudeCode"` and create managed-settings.json with allowedChannelPlugins.

## Verification
- Exactly 1 slack-channel server.ts process is running (`pgrep -af 'slack-channel.*server.ts' | wc -l` == 1)
- Its parent process is the AGENT's (`ps -o command -p <ppid>` contains the agent name or the `--channels plugin:slack-channel` flag)
- The operator's DM appears on the Slack agent's tmux pane in a `<channel source="slack" ...>` tag

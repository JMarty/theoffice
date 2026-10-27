---
name: agent-watchdog
description: Check agent health every 5 min, restart dead sessions
---

Run this quick health check. Do NOT search memory, do NOT do anything else. Just run these bash commands and act on results:

1. Run: tmux list-sessions 2>/dev/null | grep agent
2. Compare against expected agents: the finance agent, the home agent, the sales agent (and the tools agent, the travel agent, andy once they have bots)
3. For any missing session that SHOULD be running (has a Telegram bot configured), restart it. PREFERRED METHOD — the dashboard API (clean, works because the main agent runs as $USER already, no sudo password prompt):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" \
     "http://localhost:3430/api/agents/AGENT/start"
   sleep 3
   tmux list-sessions 2>/dev/null | grep agent-AGENT
   ```
   Verify the dashboard agent first via `/api/agents` (look for `hasTelegram:true` and `running:false`). Fallback to the sudo+tmux command below ONLY if the API is down.

   FALLBACK (legacy, requires interactive sudo password — rarely needed):
   sudo -u $USER bash -c "export PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH && cd $OFFICE_TENANT_ROOT/agents/AGENT && export TELEGRAM_STATE_DIR=$OFFICE_TENANT_ROOT/agents/AGENT/.claude/channels/telegram && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && tmux new-session -d -s agent-AGENT \"export PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\\\$PATH && export TELEGRAM_STATE_DIR=$OFFICE_TENANT_ROOT/agents/AGENT/.claude/channels/telegram && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && cd $OFFICE_TENANT_ROOT/agents/AGENT && claude --continue --dangerously-skip-permissions --model 'claude-opus-4-8[1m]' --channels plugin:telegram@claude-plugins-official\""
4. CRITICAL after any (re)start — clear the "Remote Control" prompt. A freshly started session shows an interactive "Remote Control / available in the Claude mobile app... Enter to select" modal and BLOCKS on it: the process is alive (running:true) but FROZEN and deaf to Telegram. Send a keypress to each agent you started:
   ```bash
   for a in AGENT1 AGENT2; do
     bottom=$(tmux capture-pane -p -t agent-$a 2>/dev/null | grep -v '^$' | tail -3)
     echo "$bottom" | grep -q "Enter to select\|❯ Continue" && tmux send-keys -t agent-$a Enter && echo "$a: cleared prompt"
   done
   ```
   IMPORTANT: only grep the LAST 3 non-empty lines (tail -3). The "Remote Control" text lingers in scrollback even after you clear it, so a whole-pane grep gives FALSE positives. Blocked = "Enter to select" / "❯ Continue" at the very bottom. Ready = bottom shows the input box (❯) + "bypass permissions on ... esc to interrupt". Sometimes there are TWO modal screens, so send Enter, re-check the bottom, and send again if still blocked. Skipping this = "running but nobody answers."
5. If you restarted any agent, send ONE short Telegram message to $USER (chat_id <id>): "Watchdog: restarted [agent names]. They are back online."
6. If all agents are running, do nothing. No Telegram message. No memory writes. Just finish silently.

# fleet freeze (the red button)

While `<tenant>/store/fleet-freeze.json` exists:
- every Claude Code agent tool call is rejected by a PreToolUse hook (`freeze-hook.sh`, matcher `*`, ~2 ms, no engine needed): no files, commands or mail. The one exception is an agent speaking to the owner: a plain `office-say "text"` (or a quoted-heredoc `office-say <<'EOF'`) still goes through, strictly matched by `freeze_allow.py` (no second command, pipe, redirect or substitution), so a frozen agent can tell the owner it is frozen. The freeze never touches the engine's outbound queue or `/api/outbound`. Agents on a runtime without these hooks (codex, e.g. pete) are NOT stopped mid-turn: they finish the turn they are in, then receive nothing new;
- the engine's scheduler and deliverer stand still (queued messages keep and drain on thaw). Scheduled work that came due during the freeze is NOT lost: the catch-up watermark is kept, and the first tick after the thaw fires the latest missed occurrence per task (6 h window), like after an engine outage. The catch-up is capped at 6 h and one occurrence per task, so a freeze longer than 6 h still skips the earlier occurrences;
- sessions and their context stay alive.

An unreadable freeze file still means frozen.

Freeze: any dashboard-token holder, including an agent: `POST /api/fleet/freeze {"reason":"..."}` (header `X-Office-Agent` names who); the owner gets a Slack DM. Or the owner DMs `freeze fleet <reason>` (also `!freeze <reason>`).
Thaw: ONLY the owner: DM `unfreeze fleet` (also `!unfreeze`) from the owner's own Slack user id, or delete the file in a terminal on the machine. There is deliberately no unfreeze API: every agent holds the dashboard token.
Slack eats a leading slash as a client slash command, so `/freeze` and `/unfreeze` never arrive: use the words above. The owner thaw must be tested with the real owner account before the hook is installed.
State: `GET /api/fleet/freeze`.

Install: `python3 tools/fleet-freeze/install_hook.py` (idempotent, `--remove` restores). Claude Code reads hooks at session start, so agents pick it up on their next (re)start: restart the fleet once. The hook lives in the shared `~/.claude/settings.json`, so it also freezes the owner's own Claude Code CLI; thaw from a plain terminal.
Residual risk of the office-say allowance: it trusts the NAME `office-say` as resolved through PATH (`~/.local/bin`, same unix user), so an agent that replaced that file BEFORE a freeze could make it do more; comparing the file hash in the hook would close it. A dashboard Unfreeze relies on the Cloudflare Access session (730 h by default): a stolen owner token is replayable until it expires, the Slack DM sent on every thaw is the control, and a shorter Access session (24 h to 7 d) is the owner's call.
Not covered: a process an agent already started in the background, a leaked credential used off the machine, anyone with a shell on the box. Agents on another machine do not see this machine's file.
Tests: `python3 -m unittest discover -s tools/fleet-freeze -p 'test_*.py'`, `npx vitest run src/fleet`.

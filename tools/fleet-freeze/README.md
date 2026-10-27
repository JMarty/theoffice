# fleet freeze (the red button)

While `<tenant>/store/fleet-freeze.json` exists:
- every agent tool call is rejected by a PreToolUse hook (`freeze-hook.sh`, matcher `*`, ~2 ms, no engine needed) — no files, commands, mail or channel replies;
- the engine's scheduler and deliverer stand still (queued messages keep and drain on thaw);
- sessions and their context stay alive.

An unreadable freeze file still means frozen.

Freeze: any dashboard-token holder, including an agent: `POST /api/fleet/freeze {"reason":"..."}` (header `X-Office-Agent` names who); the owner gets a Slack DM. Or the owner DMs `freeze fleet <reason>` (also `/freeze`, `!freeze`).
Thaw: ONLY the owner: DM `unfreeze fleet` (also `/unfreeze`, `!unfreeze`) from the owner's own Slack user id, or delete the file in a terminal on the machine. There is deliberately no unfreeze API: every agent holds the dashboard token.
State: `GET /api/fleet/freeze`.

Install: `python3 tools/fleet-freeze/install_hook.py` (idempotent, `--remove` restores). Claude Code reads hooks at session start, so agents pick it up on their next (re)start: restart the fleet once. The hook lives in the shared `~/.claude/settings.json`, so it also freezes the owner's own Claude Code CLI; thaw from a plain terminal.
Not covered: a process an agent already started in the background, a leaked credential used off the machine, anyone with a shell on the box. Agents on another machine do not see this machine's file.
Tests: `python3 -m unittest discover -s tools/fleet-freeze -p 'test_*.py'`, `npx vitest run src/fleet`.

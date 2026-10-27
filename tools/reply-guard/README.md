# reply-guard (Stop hook, main agent only)

If the turn that is ending answered an owner Slack message ("[Slack message from the owner]") but nothing was sent to the owner (no `office-say`, Slack send tool, or Slack file upload after that message), the stop is blocked ONCE with a reminder. Heartbeats, scheduled tasks, bus messages and task notifications are skipped; owner closers ("ok", "thanks", an emoji) need no reply (same classifier as owner-ack-guard; a `?` is never a closer). `stop_hook_active` always passes, so it cannot loop. Any error or unreadable transcript allows the stop.

- Acts only for `REPLY_GUARD_AGENT` (default `marveen`); the hook lives in the shared `~/.claude/settings.json`, other agents exit immediately.
- Mode `store/reply-guard.mode`: `log` (default: records what it would block in `store/reply-guard.log.jsonl`, never message text) or `enforce`.
- `python3 reply_guard.py replay --days 7` walks the main agent's real transcripts and counts owner turns, answered, closers and would-blocks.
- `python3 install_hook.py` adds the Stop hook (idempotent, `--remove`, backup). Sessions read hooks at start: restart the main agent once.
- owner-ack-guard and owner-watchdog stay as the backstop for what this hook cannot see.

While the fleet is frozen (`store/fleet-freeze.json`) the guard always allows (the freeze hook denies office-say too).
Known blind spots: a turn ended by context compaction is not a Stop; two owner messages queued in one turn are judged by the last one; a reply sent by a spawned subagent or background task is not in the main transcript (a false block: one extra prompt); any Bash command mentioning office-say counts as answered (the safe direction).
Before enforce: read a week of `store/reply-guard.log.jsonl` and list every would-block with its follow-up.
Tests: `python3 -m unittest discover -s tools/reply-guard -p 'test_*.py'`

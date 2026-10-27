---
name: fleet-token-usage-breakdown
description: Measure per-agent Claude token usage over a time window from the transcript logs. Use when Owner asks "how much did each agent use", "usage is going crazy", "which agent is eating my usage", or for the recurring 6-hour usage report.
---
# Fleet token usage breakdown

## When to use
- Owner asks who/what is consuming his Claude usage, or usage feels high.
- The scheduled `agent-usage-report-6h` task fires (every 6h).
- You need to attribute consumption across the fleet for a period.

## Procedure
1. Run the durable script (takes HOURS as arg, default 6):
   `python3 <old-install>/scripts/agent-usage.py 6`   (use 24 for a day, 168 for the week)
2. It reads each agent's `~/.claude/projects/*/*.jsonl`, sums `message.usage` tokens within the window, maps project dir -> agent, and prints a ranked %-share table + the top consumer.
3. Report to Owner on Telegram (chat_id <id>), mobile-friendly, %-share highest-first, call out the top consumer. ALWAYS INCLUDE ABSOLUTE VOLUME: the script's TOTAL window line (M tokens incl. cache + output tokens) + the top consumer's absolute (e.g. "marveen 51% = 165M tokens"). % must be anchored to a real number. State once that % = relative share of weighted consumption, NOT the actual subscription bill.

## Key facts
- Project dir -> agent: the transcript dir name encodes the agent's working directory (`$OFFICE_ROOT` itself = the orchestrator; `<...>-agents-<name>` = that agent); a bare home-directory entry = a stray CLI session.
- The %-share is cost-weighted (Opus PAYG per-MTok: in 15 / out 75 / cache-write 18.75 / cache-read 1.5) so cache-reads/output are comparable. It is a SHARE proxy, not HUF/USD owed.
- Baseline: always-on heartbeats that reload a large context on every tick can dominate usage; cutting the heartbeat frequency and moving the polling to a no-LLM daemon removes that idle cost.

## Pitfalls
- jq is NOT installed; the script is python3, parse with python only.
- Big logs: the script streams and skips lines without `"usage"`; still can take a few seconds.
- Don't present the weighted dollar figure as a bill: the owner may be on a subscription. Always label it relative-share.
- A spike for jim/ryan/cfo etc. is usually REAL work (a brainstorm), not waste; marveen's idle-poll share is the waste to watch.
- **FAN-OUT is the dominant ACTIVE-work cost driver** (measured): during heavy orchestration the SUB-AGENTS dwarf marveen, because one Owner message fans out to 3-4 Opus-1M agents each with big contexts. Example: the sub-agents together can account for around four fifths of the usage. The shipped idle-cost cut does NOT reduce this — it's active work. When diagnosing a spike, check the fan-out, not just marveen. Partly CONTROLLABLE by marveen: don't re-ack pure acknowledgments, batch delegations instead of ping-pong (the migration freeze got re-confirmed ~4x = wasted sub-agent turns). Levers: cheaper model for grunt-work agents, tighter orchestration, time heavy execution around the weekly reset.

## Verification
- Output lists agents with non-zero usage, ranked, summing to ~100%.
- Telegram report sent (transcript text never reaches Owner).

- **RAW-VS-BILLED CLARITY**: the script's `tot` is RAW throughput and mostly cache reads (cheap, NOT counted 1:1 toward a plan limit). When reporting absolute volume, lead with output tokens (the real work) and the cost-weighted share, and label the big total as "mostly cache re-reads" so it is not misread against a rate limit.

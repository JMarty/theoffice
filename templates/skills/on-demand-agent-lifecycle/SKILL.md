---
name: on-demand-agent-lifecycle
description: Activate or operate the on-demand agent lifecycle (local-patch 0007) to cut idle RAM/cost on a box running many resident agents. Agents sleep when idle and wake on a real message or scheduled job. Use when Owner says "too much RAM/idle cost", "spin agents down when not needed", or when standing up a new box (migration / second box) that should launch lean.
---
# On-demand agent lifecycle (local-patch 0007)

## When to use
- A box keeps many agents resident; idle RAM/cost is too high.
- Standing up a new box that should launch lean (migrated Office box, second box).
- Operating the running lifecycle: promote/demote an agent, troubleshoot.

PROVEN 2026-05-31 on the live box: RAM used 3.35GB→1.4GB (−1.95GB), claude RSS −67%, 10→2 resident, zero restart-war.

## Key facts
- **lifecycle field** in `agents/<name>/agent-config.json`: `resident` | `scheduled-wake` | `on-demand`. Missing/unknown ⇒ defaults to **resident** (backward-compat: a box with no fields set behaves exactly as before — activation is strictly opt-in).
- **Reaper** (60s non-LLM loop, in dashboard beside message-router/channel-monitor): releases an idle non-resident agent only if idle >12min AND pane idle AND no pending msg AND no cron within 5min. NEVER touches `resident` (marveen always excluded).
- **Wake**: start-on-inbound (router starts a stopped target before delivering) + start-on-fire (scheduler starts before a cron fires). Both gated by **CONCURRENCY_CAP=4** (tunable via `setConcurrencyCap`); over-cap ⇒ queue, no unbounded starts.
- **Promote/demote**: `POST /api/agents/<a>/lifecycle` (marveen is rejected — MAIN_AGENT_ID guard, GET returns resident / POST 400).
- **Revert**: `bash scripts/lifecycle-revert.sh` = force all→resident + restart. Arm it before any activation.

## CRITICAL coordination (the catch that bit us)
The channel-monitor **fold** (local-patch 0006) dead-session sweep restarts any `hasChannel && !isRunning` agent within 60s. Left naive, it FIGHTS the reaper → stop/start restart-war (which looks exactly like "agents constantly working"). 0007 fixes it: `shouldRestartDeadSession` is **lifecycle-aware** — `channel-monitor.ts:256 if (lifecycle !== 'resident') return false`. So the fold revives ONLY resident agents (real crash); reaper-released on-demand/scheduled-wake agents are left to the lifecycle layer. ALWAYS verify this coordination on any box before activating (the #1 QA item).

## Procedure (activation — proven)
1. Build/verify 0007 present + tsc clean. **Rebuild dist fresh from the verified-clean tree** (esp. after any tree mishap) so the restart loads known-good code.
2. **Capture RAM baseline**: `free -h` + per-agent claude RSS + session count.
3. **Set the roster** in each `agent-config.json` (`model`-style edit, preserve other fields):
   - `resident`: marveen (always). Temporarily promote the hot agent for an active project (darryl during a migration, ryan during a live external collab); demote after.
   - `scheduled-wake`: agents with cron jobs (cfo, dwight, pam, toby, darryl).
   - `on-demand`: no-schedule agents (andy, jim, kevin, pete, ryan).
4. **Restart the dashboard** to engage (loads 0007 + starts the reaper loop).
5. **Watch ~13-15min** (the 12-min idle threshold must elapse before the first release): confirm reaper releases the idle on-demand agents AND run the **WAR CHECK** — grep the log for any "Dead sub-agent session restarted" AFTER the activation timestamp = must be ZERO. If a war or an agent goes dark wrong → flip the revert instantly.
6. **Capture RAM after** → report before/after delta.

## Pitfalls
- **The drop is NOT instant** — the reaper waits 12min idle. Tell the user up front, or they'll see all agents still up right after activation and think it failed. (2026-05-31: pre-warned Owner, avoided a "why are they all still up?" round-trip.)
- **Never set the QA/audit agent (toby) to on-demand** if it's your mistake-net — keep it available. Keep marveen resident always (it's also code-guarded).
- **Delegation-only (v1)**: a STOPPED sub-agent's bot isn't polled, so a direct user/external DM won't wake it instantly (Telegram queues server-side ~24h, not lost). Fine because Owner talks only to marveen; for an externally-facing agent (ryan/ExternalDev), promote it to resident during the live collab. A non-LLM Telegram/Slack dispatcher is the v2 (= the Slack single-ingest pattern, build once).
- **Keep the migration operator resident through the migration window** — don't let the agent running a migration get reaped mid-operation; demote after it verifies green.
- **Reaper/fold war** = the failure mode; see CRITICAL coordination above. Always verify `shouldRestartDeadSession` is lifecycle-aware before activating.
- **META-PRINCIPLE — coordination invariants must be STATE-based, not TIMING-based.** Caught twice (2026-05-31): the reaper/fold war (a stopped agent's "dead" state vs the fold reviving it) AND the doorbell boot-window two-poller risk (a "claimed/starting" agent vs a 3s reconcile re-grabbing its bot). In both, a design leaned on a timing margin ("the other loop runs slower / the agent boots later") — which is exactly how the race slips through under load. The fix is always the same: an explicit STATE every path checks (lifecycle field; a CLAIMED/STARTING flag), cleared only on a confirmed transition, never "it'll probably be fine because of timing." When reviewing any new fleet-coordination piece (doorbell, dispatcher, supervisor), find where it relies on timing and demand a state guard instead — and make the QA test exercise the slow/adverse-timing case explicitly.

## Verification
- RAM used dropped; resident count = intended set; reaper log shows the expected releases.
- WAR CHECK: zero fold-restarts after the activation timestamp.
- Residents (marveen + any promoted) stayed up; revert script armed.

---
name: fleet-agent-model-tiering
description: Change a fleet agent's Claude model — tier grunt-work agents DOWN to a cheaper model (Sonnet/Haiku) to cut usage, or move one UP to Opus/Fable for harder reasoning. Encodes the Fable 5 10-80-10 cost framework: Fable for planning+review (10%), Opus/Haiku for execution (80%), Fable for synthesis (10%). Use when Owner says "put the grunt agents on a cheaper model", "usage too high", or an agent needs more/less reasoning. Includes the no-mistakes guardrail.
---
# Fleet agent model tiering

## Fable 5 — 10-80-10 framework (2026-06-12)

Fable 5 (`claude-fable-5`) exits the included tier on Jun 22 2026 — after that it costs.
Oscar must set a hard API spend cap before Jun 22 (see Oscar escalation below).

Pattern: use Fable SPARINGLY for the 10% where its reasoning genuinely matters:
- **Planning (10%)**: complex multi-step task decomposition, architectural decisions, sprint planning
- **Execution (80%)**: Opus or Haiku depending on task complexity — the bulk of all work
- **Review/synthesis (10%)**: final QA, output synthesis, cross-agent consistency checks

Fable penalises long, rigid CLAUDE.md instructions — keep prompts lean and principle-based, not rule-lists.

**Fable is NOT a default upgrade**: only reach for it when the planning or synthesis step is genuinely hard. Defaulting Fable for everything kills the cost benefit.

**Fleet assignment (post Jun-22 Fable cost era):**
- Fable: marveen (orchestrator planning + synthesis), toby (deep QA/audit on complex diffs)
- Opus: darryl, cfo, pam, jim, ryan, dwight (high-stakes execution)
- Sonnet: pete, and any agent doing structured retrieval/light reasoning
- Haiku: heartbeats, simple data fetchers, scheduled polling agents

**Oscar escalation (MANDATORY before Jun 22):** send inter-agent message to `cfo` to set a hard Anthropic API spend cap before Jun 22 2026. Without it, the fleet has no ceiling when Fable starts billing.

## When to use
- Owner wants to cut usage by running low-stakes agents on a cheaper model.
- An agent needs upgrading to Opus/Fable (more reasoning) or downgrading to Sonnet/Haiku (grunt work).
- Implementing the 10-80-10 loop for a specific workflow.

## Procedure
1. **Model is per-agent** in `agents/<name>/agent-config.json`, field `model`. It's read at start by `readAgentModel()` (src/web/agent-config.ts); `resolveModelId` maps aliases. `DEFAULT_MODEL = claude-sonnet-4-6`.
   - Aliases: `opus`→`claude-opus-4-8[1m]`, `sonnet`→`claude-sonnet-4-6`, `haiku`→`claude-haiku-4-5-20251001`. Full IDs also accepted.
2. **Set the field** (preserve all other keys):
   `python3 -c "import json;p='agents/<name>/agent-config.json';c=json.load(open(p));c['model']='claude-sonnet-4-6';json.dump(c,open(p,'w'),indent=2)"`
3. **Restart to apply** (model is only read at start): `POST /api/agents/<name>/stop` then `/start` (Bearer `store/.dashboard-token`). The channel-monitor fold auto-clears the Remote-Control modal within ≤60s, so no manual modal-clear needed post-restart.
4. **Verify**: config field set + `tmux has-session -t agent-<name>` up + `/api/agents` shows the live model (dashboard reads it from the agent's config dir, commit #206).

## Which agents — the no-mistakes guardrail (CRITICAL)
Owner's standing rule when tiering: "make sure they don't make mistakes." Satisfy it structurally:
- **SAFE to Sonnet** — low-stakes / easily-verified / harmless-if-wrong: agents for recipes, property admin, knowledge cards.
- **KEEP on Opus**:
  - **toby — the QA/audit guardrail. Keep him smart ON PURPOSE**: he's the net that catches the cheaper agents' mistakes. Never tier the QA agent.
  - High-stakes reasoners whose mistakes cost: darryl (runs migrations/infra), cfo (numbers), pam (travel), jim + ryan (product reasoning), marveen (orchestrator). dwight is borderline (touches briefing timing) — keep Opus unless asked.
- **Rule**: never tier the QA/audit agent; never tier an agent whose mistakes are costly or hard to reverse. Then MONITOR the tiered agents and REVERT any that get sloppy (`model`→opus + restart).

## Pitfalls
- **Model is NOT in `settings.json`** — that's regenerated from the security profile on every start. Model lives in `agent-config.json`. Editing settings.json does nothing.
- **Foreground `sleep` is blocked** in the Bash tool — don't `sleep` to wait for the restart. Verify via the config field (definitive: readAgentModel reads it at start) + `tmux has-session`; the fold/next-tick covers a slow start.
- **Restart cost**: each restart reloads the agent's context (tokens). Tier idle/light agents; batch the restarts.
- **Don't oversell tiering as the cost fix**: idle light agents barely consume, so tiering them saves little. The dominant active-work cost is the high-stakes agents + the orchestration fan-out (see [[fleet-token-usage-breakdown]]). Real savings = leaner orchestration + timing heavy work around the weekly reset.
- **You CANNOT manually stop an agent while the channel-monitor fold is active**: the fold's dead-session sweep (local-patch 0006) restarts any `hasChannel && !isRunning` agent within ≤60s. So a manual `stop` bounces right back, and an idle-reaper that stops on-demand agents will fight the fold (stop/start war — which itself *looks like* an agent "constantly working"). Stopping agents to save RAM requires the fold to be made LIFECYCLE-AWARE first (only revive resident/crashed agents, never a lifecycle-released one). Until then, a restart only re-applies the model; it doesn't let the agent sleep.
- **A tiering restart causes a one-time flicker**: stop+start with `--continue` makes the agent resume + possibly compact = a visible burst of activity right after the switch. Don't mistake it (or have the user mistake it) for ongoing work — verify with `ps pcpu` (idle = ~0%) + the pane showing the empty `❯` prompt.

## Verification
- `agents/<name>/agent-config.json` `model` = intended value; session up; `/api/agents` shows the new live model.
- The QA/audit agent (toby) is STILL on Opus.

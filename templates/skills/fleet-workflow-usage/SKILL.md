---
name: fleet-workflow-usage
description: When and how a marveen fleet agent should (and should not) use the Claude Code Workflow tool safely. Use before reaching for multi-agent orchestration, fan-out, deep research, big audits, or large bug/lead sweeps. Covers the cost guardrails, per-phase model mixing, and the opt-in rule. Read this BEFORE calling Workflow.
---
# Fleet Workflow Usage (cost-safe multi-agent orchestration)

The Claude Code Workflow tool moves sub-agent orchestration out of your main context into a deterministic script: it fans out work to many isolated sub-agents, runs loops, and returns only the final answer. Powerful, but it burns tokens fast. This skill is the fleet rule for using it without nuking the budget.

## When to use (the only good reasons)
- The task **fans out across many similar items** (e.g. lead-gen over 200 prospects, audit every file, sweep every channel).
- You need a **deterministic loop** that relentlessly drives to a goal (keep finding until dry / until count reached).
- You need **resumability** mid-run on a long job (workflows journal state and can pause/resume).
- A genuinely **hard single problem** that deserves exhaustive, adversarially-verified research (deep-research skill is workflow-backed).

If the work is daily, repeatable, and reliability-critical -> use a SKILL, not a workflow. Skills give determinism cheaply. Workflows are the occasional heavy hammer.

## When NOT to use
- Routine daily tasks (briefings, single lookups, one email, one card). Massive overkill.
- Anything a single skill or a couple of direct tool calls already handles.
- "Ultra-code" auto-workflow mode that workflow-ifies every substantive task. Do NOT enable it fleet-wide - it is a token incinerator.

## The cost reality (read this every time)
- One ordinary deep-research run measured ~105 agents, ~3.1M tokens, ~15 min. The **adversarial verify phase** (N-vote fact-check per claim) is the biggest sink.
- Under the flat Anthropic subscription this is absorbed until limits. **Once anything routes through Agent SDK credit metering (post the fleet's API-cost cutover), an unguarded workflow can get genuinely expensive.** See fleet cost context (memory: reference_fleet_api_cost).
- Therefore every fleet workflow MUST have a budget guard and should lean on cheap models for the wide phases.

## Mandatory guardrails for fleet workflows
1. **Budget cap.** Set a token/agent ceiling in the script. Never run an open-ended loop with no boundary.
2. **Per-phase model mixing.** Use Haiku for discovery/fan-out (the wide, cheap part), Sonnet for mid creative/critique, Opus only for the final synthesis. Do not run 100 Opus agents for a fan-out.
3. **Right-size the swarm.** 16 concurrent agents is the hard cap; 1,000 total per run. Don't request a 1,000-agent verify unless the problem truly needs it.
4. **Inspect before run.** The permission dialog shows the script - check agent count, parallelism, and the budget guard before approving.
5. **Explicit opt-in only.** A fleet agent calls Workflow only when Owner (or the coordinating agent on his behalf) has asked for multi-agent orchestration / a heavy sweep. Do not auto-escalate a normal task into a workflow. When unsure, propose it and the rough cost first.

## Who reaches for it (fleet routing)
- **Jim (lead-gen):** fan-out lead generation + qualification at scale (replaces brittle skill chaining).
- **Toby (QA / drift):** large codebase bug sweeps, multi-dimension audits, drift detection across the fleet.
- **Pete (me, research):** exhaustive deep research on one hard question - my deep-research skill already runs on this engine.
- **Any agent:** only for the use cases above, with the guardrails, and only on request.

## Pitfalls
- Tokens rack up silently and fast - a "quick" research can hit millions. Always cap.
- The VS Code extension can't run workflows; needs the desktop app or IDE terminal (fleet agents run in tmux CLI - fine).
- No direct filesystem/shell from the workflow script itself (the sub-agents can). Design accordingly.
- Don't confuse "isolated context" with "free" - isolation saves your MAIN context, it does NOT reduce total token spend.
- Saved workflows persist and can be re-run; name + describe them clearly so the right one is reused, not a near-duplicate rebuilt.

## Verification
- Before approving: budget guard present? cheap models on the wide phases? agent count justified?
- After run: check actual tokens/agents used against expectation; if it overshot, tighten the cap or phase models next time.
- Was this genuinely fan-out / deterministic-loop / resumable work? If a skill would have done it, use the skill next time.

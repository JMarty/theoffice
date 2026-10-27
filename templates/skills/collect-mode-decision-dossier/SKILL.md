---
name: collect-mode-decision-dossier
description: Orchestrate a live multi-agent brainstorm into a clean decision dossier WHEN THE PRINCIPAL IS AWAY and has said "just collect, I'll review later / don't push me for decisions now." Run the team, hold every outward/irreversible action, reconcile contradictions before they reach him, escalate only true gates, and do NOT spam him while he's out.
---
# Collect-mode decision dossier

## When to use
- Principal (Owner) is unavailable (traveling, "I'll review tonight") AND a decision-generating activity is live: a partner brainstorm (e.g. ExternalDev↔Ryan), a pricing/strategy thread, agents surfacing choices.
- Explicit triggers: "just collect the things for now", "I'll review these later", "let X and Y keep talking", "still brainstorming".
- You are the orchestrator (marveen) and agents keep pinging you with decisions that are the principal's call.

## Procedure
1. **Flip to collect mode the instant he says so.** Stop relaying every sub-decision to Telegram. One acknowledgment ("switching to collect mode, no more decision pings tonight"), then go quiet to him.
2. **Let the generators run.** Tell the talking agents (Ryan↔ExternalDev) to keep going at partner altitude; nothing gets committed to the external party.
3. **HOLD every outward/irreversible action** until he nods: public-page redeploys (Darryl), shared-doc edits, anything customer-facing, any access change. Tell the owning agent "HOLD, no prep, no deploy, wait for my go." Confirm they're holding.
4. **Reconcile contradictions BEFORE they reach him.** When two agents give fighting facts (e.g. one agent floats a cheap option, another prices a much dearer one), do NOT forward both. Push back to the source, make them produce ONE internally-consistent artifact (a hardware ladder, a single number set). The dossier he reads must not contradict itself.
5. **Elevate only TRUE gates.** Distinguish "informational" (capital is moot now) from "blocking" (which product do we sell / is this ToS-compliant). Re-rank the decision set as facts land — the real gate often moves (it can move from "wording" → "what are we selling" → "is the delivery model even legal").
6. **One agent owns the dossier file.** Have the relevant agent maintain a single living doc (e.g. agents/jim/docs/<project>-dossier.md). You keep the canonical decision set in a HOT memory so it survives a context compaction and surfaces when he's home.
7. **Hand off clean when he returns.** Present the gate first, then the falls-out-of-it items. "One real decision (which product leads); everything else follows."

## Pitfalls
- Do NOT batch a Telegram reply with the lookups it quotes — gather results first, reply after (recurring fleet failure).
- Collect mode ≠ silence to the TEAM. Keep routing/acknowledging inter-agent; just stop pinging the PRINCIPAL. The mandatory heartbeat keepalive still runs.
- Don't over-save memory: ONE hot memory for the live decision set, update its framing as it sharpens, rather than a new memory per agent message.
- A security/legitimacy flag (ToS, compliance, "can we even legally do this") is a TRUE gate even if finance looks fine — elevate it above cosmetic decisions.
- Never let an excited margin number stand unqualified if it depends on an unchosen model (for example BYO vs reselling). Force the conditional to be stated.
- Inter-agent message close uses status `done` / `failed`, never `completed`.

## Verification
- Principal got AT MOST a light "collected, review when home" — no decision spam while away.
- The dossier is internally consistent (no two agents' numbers fight).
- Every outward/irreversible action is verifiably on hold (the owning agent confirmed).
- The HOT memory names the file, the ranked gate, and what's held — enough to run the handoff cold.

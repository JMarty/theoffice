---
name: office-character-soul
description: Give a fleet agent a deep, psychologically real Office-character personality (SOUL.md) plus a rotating 12+ catchphrase deck, and de-force the old "say X every conversation" quotas in its CLAUDE.md. Use when Owner says an agent feels flat / "just 2 catchphrases, no personality," wants a real soul, or a new agent needs character depth.
---
# Office-character deep soul + rotating bit deck

## When to use
- Owner says agents "have like 2 catchphrases, no personality," feel forced, or wants them to "feel like actually working with these characters."
- A new fleet agent needs a real personality, not a thin bullet list.
- Trigger phrases: "give them a real soul," "deeper personality," "more catchphrases but not the same ones."

## Key insight (why it felt forced)
The forcedness came from TWO places, fix BOTH:
1. Thin SOUL.md (a few bullets, 2-3 catchphrases) -> no interior life.
2. CLAUDE.md "Tone -- these are MANDATORY" blocks ordering a catchphrase "in EVERY conversation" / "at least once per conversation" -> same 2-3 bits on a loop.
Owner's rule: catchphrases should be FREQUENT and FUNNY (almost every message is fine) but VARIED -- a deck of 12+, rotated, never the same 2-3.

## Procedure
1. **Research each character** with a subagent (general-purpose, web access). Ask for 8 angles: backstory, core psychology (what they WANT/FEAR), relationships (real emotional texture), growth arc, contradictions/hidden depths, how-they-talk + a VARIED 12+ bit bank (quote-accurate), values/code, and the 3-5 moments that reveal them. Demand depth + canon citations, not a quote dump. ~40k tokens/agent; run several in parallel via separate Agent calls.
2. **Write SOUL.md** (overwrite the thin one; Read it first if it pre-exists or Edit/Write errors). Structure that works: Who you are / What drives you / The contradiction that makes you you / How you talk / Your code / The people / Who you're becoming / **The bits -- rotate, never the same two (numbered 12-16 list)** / In the work (ties soul to the agent's actual job + keeps all task rules).
3. **De-force CLAUDE.md**: replace the `Tone -- these are MANDATORY, not suggestions:` header (Hungarian: `Tone -- ezek KÖTELEZŐEK, nem javaslatok:`; some files just `Tone:`) with a "Voice -- full self + rotating 12+ deck in SOUL.md; use often and funny but rotate, never the same 2-3; read any 'always/every conversation' below as 'often, rotating'" note. Leaves the register bullets intact, just removes the quota.
4. **Keep every task/domain/privacy rule 100% intact.** Personality only.
5. **Restart the agent** so it rebuilds its system prompt from the new files: `POST /api/agents/<name>/restart` (exists, returns 200; cleaner than stop+start). Verify `running:true` + tmux session.
6. **CRITICAL post-restart step — clear the "Remote Control" prompt.** On restart the CLI shows an interactive "Remote Control / This session is available in the Claude mobile app... ❯ Continue / Enter to select" modal and BLOCKS on it. The dashboard reports `running:true` (process alive) but the agent is frozen and deaf to Telegram. You MUST send a keypress to each session:
   ```
   for a in <agents>; do
     bottom=$(tmux capture-pane -p -t agent-$a 2>/dev/null | grep -v '^$' | tail -3)
     echo "$bottom" | grep -q "Enter to select\|❯ Continue" && tmux send-keys -t agent-$a Enter
   done
   ```
   Grep ONLY the last 3 non-empty lines (tail -3) — the "Remote Control" text lingers in scrollback after clearing, so a whole-pane grep gives FALSE positives. Blocked = "Enter to select" / "❯ Continue" at the bottom; Ready = bottom shows "bypass permissions ... esc to interrupt". There can be TWO modal screens, so send Enter, re-check the bottom, send again if still blocked. Skipping this = "running but nobody answers."

## Pitfalls
- The MAIN agent (Michael/marveen) keeps its personality in the PROJECT-ROOT CLAUDE.md + a project-root SOUL.md (not under agents/). Add a one-line "read SOUL.md, rotate the deck" pointer in CLAUDE.md's CHARACTER COMMITMENT so the rich SOUL.md actually loads.
- Edit tool needs the file Read THIS session first (a system-reminder content dump does NOT count). grep -n for the anchor line, Read that small region with offset/limit, then Edit.
- Worker agents launch with `claude --continue`, but restart still rebuilds the system prompt from current CLAUDE.md/SOUL.md, so new persona loads. Good.
- Respect prior deliberate guardrails inside a SOUL (e.g. Ryan's "don't seriously pitch WUPHF / loop in Jim for sensitive"). Carry them into the new file, don't drop them.
- `agent-config.json` status flips configured<->draft on whether BOTH CLAUDE.md AND SOUL.md exist (src/web/routes/agents.ts:304). A draft agent just lacks SOUL.md.

## Verification
- Each SOUL.md has a 12+ numbered, VARIED bit deck and real psychology, not bullets.
- CLAUDE.md no longer says "MANDATORY ... every conversation"; points to SOUL.md.
- Agent restarted, running:true, tmux session present.
- Spot-check the agent's next reply: funny, in-character, and NOT the same 2 catchphrases.

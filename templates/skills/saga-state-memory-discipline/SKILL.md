---
name: saga-state-memory-discipline
description: When a fast-moving multi-agent saga (bus back-and-forth on a single evolving problem — a fix, a reconcile, a flip) is generating many near-duplicate status memories, keep ONE consolidated state-memory and update/supersede it in place; bank a fresh memory only at real milestones. Prevents hot-tier bloat + recall noise.
---
# Saga state-memory discipline

## When to use
- You are in a rapid multi-agent thread on ONE evolving problem (a bugfix gate, a finance reconcile, a supervised flip) where the "current state" changes every few minutes.
- You catch yourself about to POST yet another `/api/memories` hot entry titled FINAL / CORRECTION / RE-PIN / RESOLVED / STATUS that supersedes one you wrote minutes ago.
- Trigger sign: a single day's saga has produced 20+ hot memories that are chains of supersessions (e.g. a multi-day reconcile can produce 100+).

## Why it matters
Each superseded intermediate is dead weight: it bloats the hot tier (drives the antiquation sweep), and worse, it adds RECALL NOISE — a future search surfaces ten stale "FINAL" variants and you must re-derive which is actually final. The owner never sees these; they are pure internal state, so churning them buys nothing.

## Procedure
1. **One saga = one state-memory.** At saga start, create a single hot memory `<SAGA> STATE` (e.g. "SPLIT FLIP GATE STATE"). Put the live picture there: current status, open items, who owns what, next signal.
2. **Update in place, don't append new.** When state changes, if the API supports update use it; otherwise POST the new consolidated state and immediately note "(supersedes <id>)" AND move the old one to cold (`POST /api/memories/<id>/category {"category":"cold"}`) so only ONE hot copy stands. Do NOT leave the chain in hot.
3. **Bank a fresh milestone memory ONLY at:** saga OPEN, a genuine owner-decision, or saga CLOSED. Those are durable; the minute-to-minute deltas are not.
4. **The bus IS the running log.** The inter-agent thread already records the play-by-play; you don't need to mirror every step into memory. Mirror only what must outlive the bus (bus messages evaporate) — the consolidated state + milestones.
5. **At saga close**, write ONE warm/shared closure memory, and cold-move the intermediate hot chain in the same pass (don't wait for the >7d antiquation sweep).

## Pitfalls
- Fast multi-agent crossing tempts a memory per inbound ("so I don't lose it"). The consolidated state-memory + the bus already hold it; a new hot entry per message is the anti-pattern.
- Don't DELETE intermediates (audit trail) — move to cold. Cold stays searchable, just de-prioritized.
- Milestone ≠ every green leg. In a multi-leg verification, the LEGS are bus/state updates; only the final close is a milestone memory.

## Verification
- After a saga, `GET /api/memories?category=hot` shows ONE state/closure memory for it, not a supersession chain.
- Hot-tier count is not spiking by dozens after a single day's saga.

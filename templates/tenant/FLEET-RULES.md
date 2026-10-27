# The Office — Fleet Operating Rules

Cross-agent rules every agent follows regardless of role. Owner-sanctioned, additive to each agent's own CLAUDE.md. Each agent's CLAUDE.md carries a compact copy of the active rules; this file is the canonical full text.

## Rule 1 — No agent sits in a foreground watch/poll loop (Owner, 2026-07-30)

An agent must NEVER pin its own session in a blocking poll/watch loop to wait for an event that "might happen in 10 minutes, 10 hours, or 2 days." Watching is cheap and dumb and belongs to INFRASTRUCTURE; only the REACTION needs an agent. Blocking on a watch disables the agent for everything else.


**How to wait for an event instead (in order of preference):**
1. **Event-driven PUSH.** Have the source fire at us: a Home Assistant automation, a webhook, or an API callback that POSTs to `/api/messages` to wake the owning agent WHEN the event happens. No one polls. (Example: a home-automation trigger that fires when a fresh device reading lands.)
2. **Register with the fleet TRIGGER SERVICE (Darryl / infra).** One always-on process (NOT an agent session) holds a registry of `{condition, how-to-check, who-to-wake}`, runs ONE cheap loop for all watches, and wakes the owning agent only when its condition fires. Register your watch, then RELEASE your session and go do other work.
3. **NEVER a tight self-poll.** A 60-second (or any short-interval) self-poll loop is explicitly rejected as too resource-heavy (Owner, 2026-07-30). Do not build a stopgap poller.

**Self-check:** if you catch yourself writing a "check every N seconds until X" loop inside your own turn, STOP — hand the watch to infra (push or trigger service) and return your session to the pool.

## Rule 2 — Third-party API work: read the docs fully, never figure it out by probing

Any agent doing ANYTHING with a third-party platform API — building, integrating, or answering what it can or cannot do — MUST fully read the platform's official API documentation FIRST (its index page enumerates every reference). Do NOT try to figure the API out by trial and error.

- **Live-probing is only allowed to CONFIRM an exact detail the docs already establish** (e.g. the precise accepted string/casing), never to discover whether a capability exists.
- **A failed API call is NEVER proof a capability does not exist.** The input (name, casing, format) may simply be wrong. Only the documented catalog is authoritative on what exists.
- Platform work starts from the fleet's fully-read API reference (kept by the agent that owns that integration), plus the live docs, not a fresh guess.


**Self-check:** before asserting to anyone what the platform can or cannot do, confirm it against the documented catalog — not a failed call.

## Rule 3 — Owner-entrusted sensitive data stays private; never wire it into a shared tool

Data the owner gives an agent to inform his own decisions, and anything sensitive about a person (health, personal circumstances), is OWNER-PRIVATE. Use it to advise the owner privately; never wire it into an app, a shared doc, a dashboard, or anything another person can see.

- **Need to know:** the owner needs it; nobody else does. Surface it to him privately, never as app data, a visible badge, or client-side content.
- **Ordinary logistics are not sensitive:** names, emails, dates, itineraries and payment or policy notes that the people running an event need are fine to use in the tools that need them, handled with normal PII care (out of git, served from a store). Only the genuinely sensitive slice is private.
- **Never client-side regardless:** data that belongs server-side must never be hardcoded into a client bundle where any authenticated user can view-source it.

**Self-check:** before putting any owner-entrusted or person-sensitive data into a tool, ask "did the owner give me this for his own decisions, or does this tool's audience actually need it?" If it's the former, keep it private and advise him with it.

> Owner board: a NON-urgent question/task/FYI for Owner goes on a card (`office-card new ...`), one topic per card, not a long Slack message.
> If he answers you on Slack instead, `office-card close <id> slack`. To ask him a follow-up on a card: `office-card comment <id> "<text>" ask`.
> An answer bundle from `owner-board` needs no reply unless you must ask something back.

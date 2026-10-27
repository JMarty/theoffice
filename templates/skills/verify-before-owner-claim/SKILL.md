---
name: verify-before-owner-claim
description: Before telling Owner ANY state he can directly contradict (approvals, "did I answer X", payment/refund status, account/feed status, trip status, "is it done") — verify the AUTHORITATIVE source and show the evidence. Agent pre-produced sections, memory, summaries, or a single wrong API endpoint are INPUTS TO VERIFY, never facts to relay. Born from 2026-07-21 when Owner caught multiple relayed-as-fact errors.
---

# Verify before an owner-facing claim

## When to use
Composing ANY owner-facing claim about state Owner can directly check/contradict:
- Morning briefing (travel approvals, "unanswered" DMs, bills caught, account status)
- Answering an owner question about state ("did PersonBL submit?", "what did I answer X?", "did it fire?")
- Status reports where you'd otherwise repeat an agent's summary or a memory snapshot

If the claim is owner-checkable, this skill applies. If it's your own just-did-it work verified against the real artifact, you're already fine.

## The one rule
**An agent's pre-produced section (Pam/Oscar), a memory snapshot, a summary, an email timestamp, or a single API endpoint are INPUTS TO VERIFY — not facts to relay.** Go to the authoritative source, read it, and state the evidence. If only an inference is possible, say so or name the definitive test — never assert an inference as certainty.

The failure this prevents: you relay an agent's read (or a wrong-endpoint result) as certainty → Owner checks the real thing → he's right, you're wrong, trust erodes. Typical sources: a stale section from another agent, an endpoint that 404s for a valid state and reads as "pending", an empty feed read as "broken".

## Authoritative source map (concrete, from real failures)
| Claim | WRONG source (proxy) | AUTHORITATIVE source |
|---|---|---|
| Approval status in an external platform | the platform's list API (it may return only completed items and 404 for an approved-but-unfinished one, which reads as "pending"/"missing") | the platform's own approval notification: its last line states the state (approved / declined / canceled / still pending). Read the latest one, not the subject line. |
| Trip **booked/ticketed** (does a ticket exist) | email arrival | `/trips/` or `/bookings/` API `status` (this IS the right source for booked-vs-not, just NOT for approval) |
| "Did Owner **answer** X?" | Pam's summary; a search-results page (paginates, misses recent) | Read the actual DM channel directly: `slack_read_channel <dm>` or `from:<@<slack-id>>` then check the LATEST, not page 1 |
| Bank/Wallet feed **"stale/broken"** | "no new records since date" (absence of data) | Distinguish "no data fetched" from "nothing happened." Empty feed on a quiet/holding account = HEALTHY. Definitive test = does a DUE transaction go MISSING. Don't conclude broken from absence. |
| Finance **sheet write** done | Drive `search_files` contentSnippet (cached index, LAGS live edits) | Read the LIVE sheet via Sheets API `values.get` |
| **Amount** (refund/invoice) | assume / expected value | Read the actual document (PDF) |
| Bills/mandates **fired** | an agent's "all caught" resting on a possibly-blind feed | Confirm via the real feed OR an alternate source (biller Gmail / bank login) if the feed is blind |

## Procedure
1. **Is the claim owner-checkable?** (approval, answered, paid, fired, done, exists, status). If yes →
2. **Map to the authoritative source** (table above; if not listed, ask: what is the system-of-record vs a proxy?).
3. **Read it.** Actually query/read the source now, this turn.
4. **State the evidence** in the reply (quote the message, cite the doc line, the sheet row, the API status).
5. **If only an inference is possible** (can't reach the source, ambiguous): SAY the uncertainty or name the definitive test — do NOT assert. ("Can't distinguish X from Y from an empty feed; the test is Z.")

## Pitfalls (all real, 2026-07-21)
- `/trips/` **404 ≠ "doesn't exist"** and ≠ "pending" — it means "not a booked trip"; check the approval DM for approval status.
- **Empty feed ≠ broken connection** — quiet account looks identical; the test is a due-but-missing transaction.
- **Agent pre-produced sections can be stale/wrong** (Pam read email timestamps as approval status; the briefing skill says "read from Pam/Oscar memory" but those are inputs to verify for owner-checkable claims).
- **Search pages miss recent** — read the DM channel directly for "who replied last."
- **Drive search snippet lags** the live sheet — use the Sheets API for a just-written value.
- **"pending in the platform" ≠ "pending on Owner"** — an earlier approver may still hold it. Confirm the stage before surfacing it as needs-his-action.

## Verification
- Every owner-facing state claim cites the source it was verified against (or explicitly flags it as an inference + the test).
- No claim rests solely on an agent summary, a memory snapshot, an email timestamp, or a single booked-only endpoint.

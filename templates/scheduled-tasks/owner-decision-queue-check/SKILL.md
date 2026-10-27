---
name: owner-decision-queue-check
description: Daily check of OWNER-DECISION-QUEUE.md; act on any item past its RAISE-BY date. Silent if nothing is due.
---

# Owner decision queue check

Read `$OFFICE_TENANT_ROOT/OWNER-DECISION-QUEUE.md`.

## Steps
1. `date +%F` FIRST — never infer today's date from context.
2. Parse each table row: the **RAISE-BY** column and the **State** column.
3. A row is **DUE** if RAISE-BY is today or earlier AND State is not a closed/answered state.
4. For every DUE row, do **one** of these and record it — never leave it as-is:
   - **RAISE IT** with $USER via `office-say`: short, leading with the decision he actually has to make, not the history. Then update the row with a new RAISE-BY.
   - **DROP IT DELIBERATELY**: move the row to the `## Closed` section with a one-line reason.
5. If nothing is due → **stay SILENT**. Heartbeat: no owner message, no bus traffic.

## Why this task exists (the QA agent, 2026-09-16)
A dated queue that nobody is scheduled to read on those dates is **prose with numbers in it**.
The file was created to convert "not today" into a date; without something that fires on the date
it is an answer waiting for a question, which is the exact failure it exists to prevent — an item
neither refused nor revisited, just never looked at on the day.

**The nagging IS the review.** An item past its date that keeps reappearing does not depend on
anyone remembering to care. Same conversion as scheduling the account audit: *wired and unscheduled
is a better answer waiting for the same question.*

## Pitfalls
- An item past its date that is neither raised nor dropped is worse than no queue, because the file
  then *looks* handled. Forcing one of the two actions is the whole mechanism.
- Do not re-raise the same item endlessly. Each raise sets a new date; if he does not answer after
  a second ask, DROP it deliberately and say so. A question repeatedly re-raised becomes noise, and
  noise is how the next real one gets skimmed.
- Raising is `office-say` only — terminal text is invisible to him.

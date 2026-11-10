---
name: engineering-discipline-gates
description: Named gates for any code/engine work (features, bugfixes, refactors, migrations) by any Office agent. Use when writing, debugging, reviewing, or claiming-done on code. Harvested from obra/Superpowers 2026-06-18, kept only the autonomy-safe gates (no human-approval steps).
---
# Engineering discipline gates

Hard gates for code work (1-3 core, 4-6 added 2026-11-01). They need NO interactive human approver, so they fit our autonomous bus model. (We deliberately dropped Superpowers' human-gated front half — design-approval, plan-approval, one-question-at-a-time — because an autonomous agent turn has no human to approve each step.)

## When to use
Any time you write production code, fix a bug, refactor, run a DB migration, or are about to claim work is "done / fixed / passing". Engine-touching agents (darryl, toby, dwight) especially; marveen as coordinator applies the verify-via-diff gate to every subagent handoff.

## Gate 1 — TDD red-FIRST (the Iron Law)
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
1. Write the test first.
2. Run it and WATCH IT FAIL (all new tests). If you didn't watch it fail, you don't know it tests the right thing.
3. Write the minimal code to make it pass. Re-run: green.
- Wrote code before the test? Delete it and re-implement fresh from the test. Don't keep it "as reference".
- This is a notch above implement-then-RED-on-revert: red-first proves the test drove the design, not just that it catches regressions.
- Exceptions (note them, don't silently skip): throwaway prototypes, generated code, pure config.

## Gate 2 — Verification before completion
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.
Before claiming any status ("done", "passing", "fixed", "green"):
1. IDENTIFY the command that proves the claim.
2. RUN it fresh, complete, THIS turn (not "should pass", not a previous run).
3. READ the full output, check the exit code, count failures.
4. Only then state the claim WITH the evidence.
- Red flags that mean STOP: "should / probably / seems to", saying "Great!/Perfect!/Done!" before running anything, about to commit/push/merge without a fresh run.
- VERIFY SUBAGENT WORK VIA THE DIFF, NEVER THE REPORT. A subagent saying "success" is not evidence — confirm via the actual `git diff` / file contents / test output. (Coordinator gate: marveen reviews delegated work by inspecting the real diff, not the agent's summary.)

## Gate 3 — Systematic debugging (root cause first)
NO FIXES WITHOUT ROOT-CAUSE INVESTIGATION FIRST.
On any bug / test failure / unexpected behavior, BEFORE proposing a fix:
1. Read the error message and full stack trace completely — it often names the cause.
2. Reproduce it consistently.
3. Find the actual root cause (why it happens), not the symptom.
4. Only then fix — at the root. A symptom patch is a failure.
- Especially under time pressure: systematic is FASTER than guess-and-thrash. "Just one quick fix" on a guess is the trap.

## Gate 4 — Rendered check for UI claims (added 2026-11-01)
A UI change is "fixed" only when a RENDERED check confirms it: a screenshot at the target widths (phone 390/412 + desktop 1366/1440) that a reviewer actually LOOKS at, plus a geometric DOM check (bounding boxes, `scrollWidth > innerWidth`, element order), not a DOM count or a green suite.
- Compare the screenshot against an EXISTING screen of the same app (paired shots), not only against the request.
- Full loop for owner-facing app changes: skill `app-change-loop`; click-through QA: `app-ux-clickthrough-qa`.

## Gate 5 — Observe the third party before the first owner test (added 2026-11-01)
When a feature works only if an OUTSIDE service fetches or calls our URL (Google Calendar subscribing to an .ics feed, a webhook sender, an OAuth redirect, a link-preview bot), put a request log + a live tail (`wrangler pages deployment tail` / `wrangler tail`, or a logging route) on that URL BEFORE asking the owner to test.
- Then run the first test yourself and SEE the third party's request arrive (method, path, status, content-type; HEAD must answer like GET).
- No request seen = the problem is upstream of our code; stop changing our code and stop spending owner tests.

## Gate 6 — Read back the stored record before issuing a special link (added 2026-11-01)
Before sending anyone a link whose behaviour depends on stored fields (reschedule invite, one-click login, prefilled form, personal page link), READ THE STORED ROW back from the database and assert the fields that drive the behaviour (e.g. `invites.reschedule_of = <old booking id>`). "Link is valid and prefilled" is a proxy, not the check.
- The create response echoing the field is necessary but not sufficient across a deploy boundary: read the row.

## Keep regardless (already our practice)
- using-git-worktrees: isolate mutating/parallel work in a worktree; main stays clean until merge.
- Branch -> self-review -> independent adversarial QA (Toby) -> rollback-safe deploy. The gate stays even when a tool/plugin doesn't.

## Pitfalls
- Don't import Superpowers' human-approval gates into autonomous turns — they stall (no approver) or get skipped (not really following it). Origin: 2026-06-18 Superpowers trial, Darryl's verdict (interactive-pair-programming vs autonomous-agent misfit).
- The full Superpowers plugin is still fine for a deliberate human-in-the-loop session (Owner + a fresh Claude in a worktree) on a big greenfield build — just not always-on fleet-wide.

- **2026-11-01, Gate 4 (rendered check):** 2026-09-27 Split item B1 passed 172 tests AND a DOM count check three times while the screenshot still showed the bug (root cause `display:flex` on a `<td>`). Owner also rejected the headshots UI 4x (10-01) until paired screenshots vs an existing screen were required.
- **2026-11-01, Gate 5 (third-party fetch):** Split calendar feed, 2026-10-02/03: three owner tests were burned before we learned Google never fetched our feed at all (zero requests on the pages.dev OR workers.dev tails; HEAD on the Pages route returned text/html until fixed). Feature parked (branch `parked/calendar-export`, darryl memory 6233).
- **2026-11-01, Gate 6 (read back before a special link):** 2026-10-14 the PersonBD reschedule link was stored WITHOUT `reschedule_of` (created in the minute after a deploy), so confirming the new slot did not cancel the old booking. Darryl adopted "read back `reschedule_of` before sending" (kops-poll BUILDING-BLOCKS.md, Booking page row).

## Check
Before merge/claim: did a test fail red first? did you run the proof command this turn and read its output? if you fixed a bug, did you name the root cause? if you delegated, did you read the diff? UI: did you look at the rendered screenshots at both widths? Third-party fetch: did you see their request in the tail? Special link: did you read the stored row back?

## Adopted from the Marvin agent-operating-kit (owner 2026-11-06: "already go in general, we roll back if we don't like it"; backup of the pre-change file in agents/marveen/work/process/)
1. *DoD before build.* No build starts without numbered, verifiable done-statements in the spec (behaviour, tests, docs/CHANGELOG, env/deploy). "Looks good" is not a DoD line.
2. *Size label on every task:* xs (mechanical, fully specified) / s / m / l / xl, written in the spec and on the kanban card title ("[s]").
3. *Model by size:* xs -> Haiku sub-agent; s -> Sonnet; m/l/xl -> the agent's own model. A failed round climbs one step (effort, then tier); the builder never self-escalates to "done".
4. *Fresh validator, two passes:* the builder never validates its own work. Pass 1 completion (tries to FALSIFY each DoD line, browser for anything web-facing), pass 2 security (secrets, auth, data exposure, dependencies). Toby or a fresh sub-agent; record both verdicts.
5. *Final-message contract* for every sub-agent / delegated build: what was done per DoD line, evidence (command + output or file path), files changed, open risks. A report without evidence per line = not done.
6. *Session budget:* at ~70% context write a handoff note; at ~80% finish the current step only; at ~90% stop and compact. Darryl's CTX-COMPACT notices are the trigger.
7. *Dependency + secrets discipline in every brief:* name the security surface; new dependencies pinned and justified; secrets never in briefs, cards, bus or commits.
8. *Card labels for statistics:* type (feature/fix/chore/docs), area (crm/site/demo/infra/home), size, origin (owner/agent/qa) in the card title or body, so a weekly digest can count them.

### Adopted round 2 (owner 2026-11-06 01:4x, after reading the whole kit README)
9. *Escalation by failure pattern, not by retry count:* after a failed round name the pattern: converging (stay), stuck (raise effort, then model tier), whack-a-mole / bloat / loop (STOP retrying and hand the problem to a new pair of eyes who must propose another route; shrink the scope only with the owner's yes), spending out of proportion (pause and ask the owner). Max 4 rounds per rung.
10. *Guardrails, four dispositions:* every "do not" must end in exactly one reaction: take the safe alternative, stop and ask what was meant, ask whoever owns the decision, or leave it out and say so. A blocked sub-agent commits its safe work and names the exact block; silence is NEVER approval.
11. *Bounded runs:* any multi-round or fan-out job states up front GOAL, numeric LIMITS (rounds, agents, tokens, minutes), a POSITIVE exit and a NEGATIVE exit, and reports between rounds.
12. *Bug-hunt and stress-test as standard QA tools (Toby):* bug-hunt = several sub-agents, each attacking from a different direction, hunt for bugs; their candidates are re-checked and only confirmed ones are filed (report only, never touch live). Stress-test = every growth dimension at 3-5x expected production scale (rows, files, users, payload size), findings filed with the scale that broke it. Run both before any client go-live.
13. *Docs taxonomy per repo* (with the handbooks): docs/plans (decided, not done), docs/research (what investigations found), docs/tech-debt (known debt + the cleanup it needs), docs/future (deliberately deferred ideas), docs/decisions.md, docs/release-notes, each with an index. PROJECT-INFO.md per repo: audience, size, app type, stack, owner, live URL, deploy path.
14. *Code docblocks:* every new or changed public function/class gets a contract docblock in whatever form that language normally uses (TSDoc/JSDoc, PEP 257); inline comments only for the non-obvious WHY.
15. *Collect once, render many:* reports (weekly digest, project close-out, a client-facing progress page) read ONE snapshot; a client/stakeholder render never shows agent names, tiers, internal labels or process.

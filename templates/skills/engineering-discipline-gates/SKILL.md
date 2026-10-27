---
name: engineering-discipline-gates
description: Named gates for any code/engine work (features, bugfixes, refactors, migrations) by any Office agent. Use when writing, debugging, reviewing, or claiming-done on code. Harvested from obra/Superpowers 2026-06-18, kept only the autonomy-safe gates (no human-approval steps).
---
# Engineering discipline gates

Three hard gates for code work. They need NO interactive human approver, so they fit our autonomous bus model. (We deliberately dropped Superpowers' human-gated front half — design-approval, plan-approval, one-question-at-a-time — because an autonomous agent turn has no human to approve each step.)

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

## Keep regardless (already our practice)
- using-git-worktrees: isolate mutating/parallel work in a worktree; main stays clean until merge.
- Branch -> self-review -> independent adversarial QA (Toby) -> rollback-safe deploy. The gate stays even when a tool/plugin doesn't.

## Pitfalls
- Don't import Superpowers' human-approval gates into autonomous turns — they stall (no approver) or get skipped (not really following it). Origin: 2026-06-18 Superpowers trial, Darryl's verdict (interactive-pair-programming vs autonomous-agent misfit).
- The full Superpowers plugin is still fine for a deliberate human-in-the-loop session (Owner + a fresh Claude in a worktree) on a big greenfield build — just not always-on fleet-wide.

## Check
Before merge/claim: did a test fail red first? did you run the proof command this turn and read its output? if you fixed a bug, did you name the root cause? if you delegated, did you read the diff?

# english-guard + needs-you-precheck — mechanism fixes (2026-08-11)

Two recurring owner-facing mistakes were being "fixed" with another be-careful memory, which kept
failing because the be-careful step is exactly what fails under context pressure. These are the
MECHANISMS that replace those reminders.

## english-guard (`english_guard.py`)
Send-time gate. Reads text (stdin/arg), exit 0 if English, exit 1 + offenders if Hungarian.
v2 (after adversarial QA): LONG Hungarian stems matched as SUBSTRING (survives agglutination — a
suffixed form is caught via its stem) + curated whole-words, NO 2-letter markers (killed the Jack Ma /
Mai Tai false-block). English naming a Hungarian proper noun still passes. Wired into `office-say`
as an OPT-IN gate: `OFFICE_SAY_ENGLISH_ONLY=1 office-say "..."` refuses a Hungarian
message. Default (env unset) = office-say unchanged, so normal Hungarian conversation is untouched.
Callers: any flow whose owner-facing text must stay English. Tests: `test_english_guard.py`.

## needs-you-precheck (`../needs-you-precheck/needs_you_precheck.py`)
First-pass filter for the briefing's Needs-You gate. Given a case-number/keywords, searches marveen
memory for a resolution marker tied to a DISTINCTIVE token (name or case number, not a generic word),
prints RESOLVED or OPEN. Purpose: stop surfacing an already-handled item as an owner action (e.g.
a certificate nagged twice after it was already sent). LIMITATION: it is a heuristic, deliberately biased
so a false OPEN (safe: item still gets surfaced + human verifies) is preferred over a false RESOLVED.
For authority/official items the skill still confirms against Gmail SENT before dropping. Tests:
`../needs-you-precheck/test_needs_you_precheck.py`.

## kanban owner-action distinction — SHIPPED as skill rule; engine field is a follow-up
A first-class `blocked_on` (waiting-on-owner vs waiting-on-third-party) field needs an engine change
(the metadata PATCH only allows priority/project). Shipped now: the briefing's Needs-You assembly
classifies each candidate and only OWNER-ACTION items reach Needs-You. Engine field deferred to Darryl.

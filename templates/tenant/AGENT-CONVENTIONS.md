# Agent conventions — adopted by agents, NOT owner-sanctioned

**Authority note, read first.** `FLEET-RULES.md` is the owner-sanctioned file: every rule in it
carries "(Owner, date)" and binds because he said so. **This file does not.** Everything here was
agreed between agents to stop a recurring defect. It is revisable by any agent with a better
argument, and nothing in it may be cited as an owner instruction. Keep the two files apart — a
convention placed among owner rules silently inherits an authority it does not have.

---

## C1 — Sign a tenant-script edit with who wrote the WORDS (marveen + darryl, 2026-09-22)

**Why this is not pedantry: under `tenant/` there is no blame layer at all.** `.gitignore:14` is
`/tenant/**` — a deliberate platform/tenant boundary, because `tenant/` carries secrets. **Do not
"fix" it by committing these files.** The consequence is what the convention answers: nine
executing `.py` files under `tenant/scheduled-tasks`, **zero tracked**, `git log` on `arm.py`
returns nothing. **So the in-file signature IS the entire authorship record**, and these are exactly
the files rewritten at speed during an incident by whoever is closest.

**The convention:**

- Sign with **who wrote the words**, not who owns the file and not who requested the change.
- **A joint edit needs both names and the mechanism between them**, because a single name cannot
  carry one. Darryl's form:

  ```
  # collect-then-exit per darryl 17169; fan-out consequence mine. dwight 2026-09-22
  ```

- Cite the **message id** for a reasoning you are implementing. It is the only pointer that
  survives, and it is what settled the case below.

**Root incident.** `arm.py:93-95` carried the signature `Darryl 2026-09-22`. Darryl quoted it back
as *"Dwight's comment, in his own words"*. Three readings survived and **none was settleable from
the repo** — it was resolved only because Darryl still held the message he had sent four hours
earlier. The true split was finer than either first reading: Darryl flagged the arm hazard **not
knowing the ordering** and offered two options; **the T-5 fan-out consequence that made option two
the only correct one was Dwight's entirely**; Dwight wrote the words and signed Darryl's name
because the option was his. Once either agent loses context, that is unrecoverable.

**Same shape as `REVERT.md`'s untraceable fold, cause inverted** — there uncommitted by accident,
here by policy — and the identical result: running code whose history does not exist. No engine
change fixes it, which is why it lives in a convention rather than on a card.

---

## C2 — A negative search result is not evidence until the same invocation has returned a positive (dwight, with marveen + toby, 2026-09-22)

**`grep` here is not `/usr/bin/grep`.** `type grep` shows a shell function that execs `ugrep` via the
claude binary with **`-G --ignore-files --hidden -I`**. Two of those flags silently hide files, and both
produce **exit 0 with no output — indistinguishable from a genuine absence**:

| filter | what it hides | how to defeat it |
|---|---|---|
| `--ignore-files` | anything matched by a `.gitignore` the walk **descends through** | start inside the tree (`grep -rn PAT ./tenant`) or `command grep` |
| `-I` | every binary file (`.pyc`, sqlite, images) | `command grep` / `/usr/bin/grep` **without** `-I` |

**Read the function instead of probing it.** `type grep` prints the whole definition; every axis below was
found empirically and is one line of it: `-G` (basic regex, so `\|` is alternation), `--ignore-files`,
`--hidden`, `-I`, and `--exclude-dir` for `.git .svn .hg .bzr .jj .sl`. *We spent an afternoon testing the
outputs of an instrument whose definition was readable the whole time (toby).* **And the function scans its
own arguments and falls through to the real binary on `-Z`, `--null`, `-z`, `--filter`, `--pager`,
`--config`, `-@`** — so `-Z` is a one-character escape hatch, verified: `grep -rl <probe> .` → 0,
`grep -rlZ <probe> .` → 1. *Cheaper than `find | xargs`, and deliberate rather than accidental.*

> **THREE SILENT FAILURES, EACH INTRODUCED BY THE FIX FOR THE ONE BEFORE IT** *(toby found the third):*
> ```
> grep -rl  <probe> .                      -> 0        1. --ignore-files hides it
> grep -rlZ <probe> . | wc -l              -> 0        2. -Z escapes filter 1; wc -l counts NEWLINES, there are none
> grep -rlZ <probe> . | grep -c .          -> (EMPTY)  3. shimmed grep has -I; a NUL stream reads as BINARY
> grep -rlZ <probe> . | command grep -c .  -> 1        real binary
> grep -rlZ <probe> . | tr '\0' '\n' | grep -c .  -> 1   NULs defused before the shim sees them
> grep -rlZ <probe> . | wc -c              -> 25       bytes; robust to all three
> ```
> **AND THE EMPTY VALUE THEN BEHAVES FIVE DIFFERENT WAYS, TWO OF THEM SILENT** *(toby):*
> ```
> [ "$x" -gt 0 ]   ->  ERROR "integer expression expected"      loud, rc=2
> [ -n "$x" ]      ->  false                                    correct
> [ "$x" = "0" ]   ->  false   <- reads as "NOT zero" = NOT CLEAN.  The careful-looking idiom
>                                 gives the most confidently wrong answer.
> (( x > 0 ))      ->  false   <- empty coerces to 0.  SILENT.
> printf "%d" "$x" ->  0       <- prints a zero that was never measured.  SILENT.
> ```
> **`printf "%d"` is the one to remember: it converts an empty capture into a literal `0` in a report,
> indistinguishable from a real count.** *The instrument produced nothing and the formatting produced a
> figure.*
>
> **The third layer is worse than the second: it does not return a wrong number, it returns NOTHING.** *An empty
> command substitution becomes an empty string; `[ "$x" -gt 0 ]` then raises `integer expression expected`
> rather than evaluating false, and in a `printf` it vanishes into the sentence around it.* **A wrong zero
> appears in the output and can be disbelieved; an empty string does not appear at all.**
> *So the escape hatch out of `--ignore-files` hands you a counting bug, and the obvious fix for the counting
> bug walks into `-I`, which is the same family of filter you were escaping — now applied to stdin.*
> **`wc -c` survives all three because it asks a different question: "did anything come back at all", not
> "how many things came back."** *That is exactly how
> this entry was nearly rejected as unreproducible — `grep -rlZ … | wc -l` → 0, `… | tr '\0' '\n' | grep -c .`
> → 1, and `od -c` showed a genuine `./tenant/.escape-probe.py\0` hit the whole time.* **The fix for a
> false-negative filter arrived with a fresh false negative attached, in the counting layer rather than the
> search layer.** *Count NUL output with `tr '\0' '\n' | grep -c .`, or read raw bytes with `od -c`.*

**A third layer exists in the neighbouring tools, and the flags are orthogonal — one does not imply the
other.** The shim bakes in `--hidden`, so it *does* see dotfiles; `ripgrep` does not, and `--no-ignore`
**does not** cover that. Measured on a directory **walk**:

```
                         dotfile   inside-a-gitignored-dir
rg (default)                0              0        both filters active
rg --no-ignore              0              1        does NOT cover hidden
rg --hidden                 1              0        does NOT cover ignore
rg --no-ignore --hidden     1              1        need BOTH
grep (shim)                 1              0        --hidden baked in, ignore active
command grep                1              1        no filters
```

*(toby found this while reproducing the table below: his probe was `.toby-blindspot-probe.txt`, `rg
--no-ignore` returned 0, and he nearly reported the table wrong. **His control for a blind-spot test had a
second, independent blind spot in it.**)*

**And a control must WALK, not name its probe.** Passing a filename as an argument makes every tool search
it regardless of hidden/ignore/exclude rules, so `rg -l PAT ./.probe` succeeds while `rg -l PAT .` skips it.
*A control that names its own probe file proves nothing about a recursive search.* **The probe files used
for the table below were dotfiles** — valid for the shim, which has `--hidden`, and a trap for anyone
reproducing them with plain `rg`.

**The ignore filter is NOT "repo-root only".** It applies to any walk that descends through the directory
holding the `.gitignore`, so **a search from the repo's *parent* is filtered too** — and that is the
dangerous shape, because `grep -rl X $OFFICE_ROOT/..` feels maximally broad and skips all of `tenant/` anyway.
Controls (probe file in `tenant/`, one variable — the start path):

```
grep -rl <probe> $OFFICE_ROOT/..               -> 0   FILTERED (parent of the repo)
grep -rl <probe> $OFFICE_ROOT     -> 0   FILTERED (repo root)
grep -rl <probe> .../theoffice/tenant      -> 1   sees it  (started inside the ignored tree)
command grep -rl <probe> $OFFICE_ROOT/..       -> 1   sees it  (shim bypassed)
```

**An explicit path into `tenant/` is genuinely unfiltered for source.** If you diff shimmed vs unshimmed
counts there and see a difference, it is `-I` dropping binaries, **not** gitignore leakage: measured from a
`tenant/` start, every *text* file appeared in both lists and the entire delta was `__pycache__/*.pyc`,
`theoffice.db` and `theoffice.db-wal`. Separating the two mechanisms is what stops a correct finding being
re-opened. *(marveen — he nearly sent a rebuttal off that count, then listed the files instead of counting
them, which is what identified it.)*

### Two more classes, and neither is a property of the tool

**Line-oriented matching.** `grep` matches within a line, so **a multi-word pattern cannot match across a
newline** and wrapped prose returns a false zero. Measured on C1: the phrase that runs from the end of
`:15` into the start of `:16` returns **0** line-by-line and **1** with newlines flattened. Both of its
single words return 1.
*(Do not reproduce this by grepping the phrase itself — the paragraph you are reading now contains it
inline, so the search matches this example instead of C1. That is the "control that passes for the wrong
reason" failing on its own documentation; test it against `sed -n '15,16p'` instead.)* *For prose, search a distinctive single token, or flatten first
(`tr '\n' ' ' < f | grep ...`).* **This is the same defect as a multi-word SQL `LIKE` on prose.**

**Filters you supplied yourself.** These are harder than the built-in ones, because you typed them and the
output never mentions them. `find -name 'FOO*'` is a **whole-basename glob, not "contains FOO"** — a date
prefix defeats it:
```
find $OFFICE_ROOT/.. /tmp -maxdepth 6 -name  'AGENT-CONVENTIONS*'  -> 1   (live file only)
find $OFFICE_ROOT/.. /tmp -maxdepth 6 -name '*AGENT-CONVENTIONS*'  -> 3   (live + both backups)
find $OFFICE_ROOT/.. /tmp -maxdepth 9 -name  'AGENT-CONVENTIONS*'  -> 1   (depth was NEVER the cause)
```
*Same family: `--include`, `--exclude-dir`, `-maxdepth`, a `head` on a pipeline.*

**A positive control must change ONE variable, or it confirms existence and invents a cause.** *marveen did
run the remedy above — he made the zero become non-zero — and still got a false diagnosis, because his
second command changed four things at once (new search roots, a `-newermt` filter, a leading wildcard, and
no `-maxdepth`). It returned the file, he read that as confirming his depth hypothesis, and it was actually
confirming a pattern hypothesis he had not formed.* **Making a zero non-zero proves the thing EXISTS; it
does not tell you why the first query missed.** A non-differential control yields a true positive with a
false cause, **which is worse than the zero, because now you believe you have investigated.**

> **And misattributing a false negative is worse than having one, because the recorded remedy does not fix
> it.** *The case above was first diagnosed as a `-maxdepth` limit; raising it to 9 still returns 1, so the
> note that would have been written down ("watch your depth") would have left the defect in place. Twice
> today: this, and my shim blindness first attributed to a missed directory.* **Diagnose a zero by making
> it become non-zero, not by finding a plausible reason for it.**

### The rule

**A negative result is not evidence until the instrument has returned a positive one in the same
invocation** — same tool, same command shape, same globs, **same start path**, and **same pattern
features**. A plain-literal control cannot validate a negative built from an alternation, a character
class or an anchor: it proves the instrument can reach the files, not that it can express the question.
*(`\|` was verified to work correctly under this shim's `-G`.)*

Where it is cheap, prefer **an instrument with a different failure mode** over a better control on the
same one — but **count failure modes, not instruments.** `grep`(shim), `ripgrep` (default) and `git grep`
(index-only) are **one** ignore-aware family; only `find + xargs /usr/bin/grep` is independent. Three
tools agreeing can be one observation counted three times.

### Corollary — prefer assertions with a non-empty expected value

**An assertion expecting absence is satisfied by total instrument failure.** Writing the `arm.py`
`REFUSED` test, a four-arg call to a three-arg function raised `TypeError` on every iteration and left the
accumulator `[]`. It was visible **only** because the expectation was `['home']`; had it been "no refusals
accumulate", a dead instrument would have produced a confident green. Every false negative found today was
absence-shaped: shimmed `grep` → 0, `-I` suppression → 0, `command` inside `xargs` (a builtin, so `xargs`
cannot exec it) → 0, `as_of or updated_at or created_at` → the wrong field.

**Do not publish "X is not referenced anywhere" off a root-relative grep.** It is how darryl's shipped
`.board-refusal.json` was reported as never shipped, and how marveen's `canary_check.py` scope claim was
made with an instrument narrower than stated. Both conclusions happened to survive. Neither had a control.

> *toby's formulation, kept verbatim because it names the whole class:* **relying on how you created
> something is an inference in a measurement slot.**

---

## C3 — Label a claim "verified" only after the verification returns (dwight, 2026-09-22)

**This is not a search rule and it is listed here because it is the one failure that corrupts the record
rather than a finding.** *I wrote "verified: `grep -rlZ` → 1" into this file, credited to toby, **before my
own verification had returned** — and when it returned it said 0, because of counting bug 2 above. The
claim happened to be true.* **Had the broken count been the last word I would have deleted a correct
finding from a shared document while quoting the control rule three paragraphs above it.**

*The same shape hit four of us in one afternoon — a scanner, a repair, a journal query, and this file — and
marveen's formulation is the general one:* **the proof is the read-back, never the return code.** *Launching
an action and reporting its intended effect is the narrowest possible version of asserting a measurement
never taken.* **Write the claim, run the check, then label it — in that order, even when you are confident,
and especially when you are writing into something other people will read tomorrow.**

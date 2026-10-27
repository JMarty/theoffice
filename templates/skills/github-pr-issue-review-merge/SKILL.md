---
name: github-pr-issue-review-merge
description: Check open GitHub issues / pull requests on our repo, review them (optionally with Darryl + Toby as a multi-agent check), and if safe merge + update the running version + report back. Use when Owner says "check the open issues/PRs", "review this PR", "there's a PR/issue from X, take a look", "merge it and update our version", or names a contributor's issue/PR. Covers external-fork PRs, the PAT auth path, the safe merge→fix→deploy ordering, and the fleet-safe restart that lets you report back.
---

# GitHub issue / PR review → merge → update → report

## When to use
- Owner: "check my open issues/PRs", "review the PR from <person>", "is it safe to merge", "merge it and update our version and report back".
- Any external contributor's issue/PR landing on `<owner>/<repo>`.

## Repo + auth (do first)
- Repo we own: `<owner>/<repo>` (the live engine on this box). An upstream-tracked fork repo follows different rules (see `repo-update-local-patches`); this skill is for `theoffice`.
- PAT: get it via `git credential fill`, NOT by reading the credential file (direct read trips a guard / exit 144):
  ```bash
  TOK=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
  ```
- `gh` CLI is NOT installed — use the REST API with that token.

## Procedure

### 1. Discover
```bash
# issues + PRs by a creator (issues endpoint returns both; PRs carry a pull_request key)
curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/issues?state=open&creator=<login>&per_page=20"
# open PRs (any author)
curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/pulls?state=open&per_page=30"
```
Note the PR's head repo: `<contributor>/theoffice:branch` = external fork (we CANNOT push to their branch; derive our own branch for any fixes).

### 2. Read the PR for real (never merge on the description alone)
```bash
# meta: mergeable, mergeable_state, additions/deletions, changed_files
curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/pulls/<N>"
# file list
curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/pulls/<N>/files?per_page=100"
# FULL DIFF -> save + read it
curl -s -L -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github.v3.diff" \
  "https://api.github.com/repos/<owner>/<repo>/pulls/<N>" -o /tmp/pr<N>.diff
```

### 3. Multi-agent review (when Owner asks for it, or for any non-trivial PR)
Delegate via `POST /api/messages` with focused questions; do your own pass too. Roles:
- **Darryl (code/infra correctness):** does it integrate cleanly with recent changes (e.g. the runtime registry)? any delivery/restart break? does autostart/lifecycle conflict? is the apply (pull+build+restart) fleet-safe? Verdict: SAFE / CONCERNS / BLOCK.
- **Toby (QA/safety):** RUN the suite in an isolated git worktree off the PR head (`tsc --noEmit` + `vitest run`), security smells, data-leak/injection, silent breakage, token/cost blow-up. Verdict: SAFE / CONCERNS / BLOCK.
- **You (PM synthesis):** overall sense + danger + architecture-specific assumptions.

### 4. Synthesize
- Weight the reviewer who **owns the touched subsystem** most heavily — a deep reviewer's CONCERNS can and should override a majority "SAFE". (A deep reviewer who finds real bugs the others under-weighted outranks the majority.)
- Specifically check **architecture-specific assumptions** an external author couldn't know (e.g. a PR that assumes an engine restart equals a new agent session; false in a decoupled-session model).

### 5. Decide
- **Clean** → merge (step 6) → deploy (step 7).
- **Concerns** → surface to Owner with options + a recommendation: (A) merge + we fix correctly + deploy, (B) request changes from the contributor, (C) merge + fast-follow. It's his repo + his contributor relationship, so let him pick — but recommend.
- **If fixing (option A):** merge the PR (credit the author) → the agent who OWNS the bug fixes it on a branch → Toby verifies in a sandbox → merge the fix → **then** deploy ONCE. Never deploy the buggy interim: hold the box on the old version until the fix is merged, then a single pull+build+restart ships PR+fix together.

### 6. Merge
```bash
curl -s -X PUT -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/pulls/<N>/merge" \
  -d '{"merge_method":"squash","commit_title":"<type>: <summary> (#<N>)"}'
# optional: delete the merged branch (only if it's OUR branch, not a fork)
curl -s -X DELETE -H "Authorization: Bearer $TOK" "https://api.github.com/repos/<owner>/<repo>/git/refs/heads/<branch>"
```

### 7. Update the running version
```bash
cd $OFFICE_ROOT
git status --porcelain | grep -v '^??'      # MUST be clean before pulling
git pull origin main
npm run build                                # tsc -> regenerate dist/  (exit 0)
npm test                                     # run the suite on the deployed tree (belt-and-suspenders)
systemctl --user restart theoffice.service   # fleet-safe (see step 8)
```

### 8. Report-back safety (why the restart doesn't strand you)
- The tmux server lives in `theoffice-tmux.service` — a **separate cgroup/unit** from the engine `theoffice.service`. `KillMode=control-group` on the engine only hits the engine's cgroup, so restarting the engine does NOT kill the tmux server: all agent sessions (including yours) **survive**, and you can `office-say` after.
- Verify the separation holds before relying on it (see `verify-restart-blast-radius`). If they ever share a cgroup, the restart would nuke the fleet AND your own session — do NOT restart blind in that case.

### 9. Verify post-deploy
```bash
T=$(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3430/api/agents   # all running (e.g. 9/9)
ls dist/<new-files>.js                                                    # new code actually built
journalctl --user -u theoffice.service --since "90 sec ago" | grep -iE "error|autostart|launched"
```
- `autostart ... launched: 0` on a restart is CORRECT — sessions survived, nothing double-launched.

### 10. Report to Owner via `office-say` (English). What shipped, that it's verified, agents healthy, anything still open.

## Pitfalls (pitfalls)
- **Never blind-merge an external PR.** Read the diff; check assumptions that are false in our architecture (session-decoupling, runtime registry, tmux-injection limits).
- **Large pane-injected content is risky.** Anything piped to an agent via tmux send-keys (memory preambles, big prompts) must be bounded by TOTAL bytes, not just item count — multi-KB injection on the fragile submit path can mis-detect the submit. (Cause of PR #8 fix #1.)
- **Hold the buggy interim.** When fixing before shipping, don't deploy between the PR merge and the fix merge — one final deploy after both.
- **External fork branches are read-only to us** — derive our own branch for fixes; merging the fork PR is fine, pushing to it is not.
- **PAT via `git credential fill`**, not file read.
- **Don't re-prime / don't manufacture** — only do what was asked; surface real forks to Owner, don't invent work.

## Verification (verification)
- Diff actually read (not just the PR description).
- Each requested reviewer returned a verdict; synthesis weighted the subsystem owner.
- Merge succeeded (`merged: true`).
- Working tree was clean before pull; build exit 0; suite green on deployed tree.
- Restart fleet-safe; agents all running after; new code present in dist/.
- Reported to Owner via office-say.

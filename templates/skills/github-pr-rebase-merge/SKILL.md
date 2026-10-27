---
name: github-pr-rebase-merge
description: Merge a stack of GitHub PRs sequentially when they share files and will cause cascading conflicts. Triggers when user says "merge the PRs in order" or similar, and the PRs come from external forks (cannot push back to PR branch).
---

# GitHub PR rebase + merge for conflicting fork PRs

## When to use

- 2+ open PRs on the same repo that overlap on files (e.g. `src/web.ts`)
- The PRs come from an EXTERNAL fork (head ref: `someuser:branch`), not from your own repo
- The user asks you to merge them all in order
- You cannot push to the PR branch (no write access to the fork)

## The core problem

If two PRs (`A`, `B`) modify the same file, after one is merged the other becomes CONFLICTING in the GitHub UI, and `gh pr merge B` fails. You cannot force-push a rebased version to an external fork, so two options remain:

1. The author rebases manually and pushes (slow, depends on a person)
2. **Rebase locally, then squash-merge into main, and close the PR manually** -- this skill

## Procedure

### 1. Check and clean merges (no conflict)

```bash
gh pr view <N> --json mergeable,mergeStateStatus
# MERGEABLE + CLEAN -> gh pr merge N --squash --delete-branch
# UNKNOWN -> wait 5-10 s and query again (GitHub lazy-resolve)
# DIRTY + CONFLICTING -> go to the conflict path
```

After each merge:
```bash
git pull --ff-only origin main
sleep 8  # GitHub needs time to recompute the mergeable status
```

### 2. Conflict path (rebase + manual merge)

```bash
# 1. Pull the PR into a local tracking branch
gh pr checkout <N>

# 2. Rebase onto main
git rebase main
# There will be a conflict. Resolve the markers (<<<<<<< / ======= / >>>>>>>)
# Typical case: two branches added a new import to the same import block -- keep both
# Typical case: comment blocks -- combine them into one new comment
# Typical case: they modify the same function for different purposes -- read both and integrate

git add <resolved files>
git rebase --continue

# 3. Test locally
npm run typecheck
npx vitest run

# 4. Try pushing to the PR branch
git push --force-with-lease
# If "rejected (stale info)" or "remote rejected" -> no write access, go to point 5
```

### 3. If there is no push access (fork scenario)

```bash
# Check out main, squash-merge the rebased branch
git checkout main
git merge --squash <rebased-branch-name>

# Commit with co-author
git commit -m "$(cat <<'EOF'
<original PR title> (#N)

Rebased and merged manually due to conflict with <prior PR or series>.

Co-authored-by: <author> <author-email>
EOF
)"

git push origin main

# Close the PR manually
gh pr close N --comment "Merged manually via rebase due to conflict with <prior PR>. See <commit-sha> on main." --delete-branch
```

## Pitfalls

- **`gh pr merge` is not enough if CONFLICTING.** Don't try it, because neither the `--merge` nor the `--rebase` flag solves it if the patch simply doesn't apply. Go straight to the local rebase.
- **After `gh pr checkout N` the branch name is the PR's head ref**, e.g. `v3-07-mcp-state-detection`. Don't be misled that it appears as a local branch. On push the `origin` is the FORK URL (`<owner>/<repo>.git`), not your own origin.
- **The "Skipped deleting the remote branch of a fork"** message is normal with `gh pr close --delete-branch`. It only deletes the local branch.
- **GitHub `mergeStateStatus: UNKNOWN`** is a transitional state, it settles in ~5-15 seconds. Don't be impatient, wait.
- **If there are several line-number-shift conflicts in one file** (e.g. 3-4 marker blocks), resolve them semantically, not just mechanically. Read the surrounding code and think about what both versions are trying to do.
- **The importance of `co-authored-by`**: this way GitHub still attributes the commit to the author, and puts a "closed" status on the PR, not "merged", but the code is in.
- **After you push to main, the state of the OTHER open PRs becomes UNKNOWN -> CLEAN or DIRTY.** You need to re-check the status of each before merging, because the freshly merged commit may have generated a new conflict.
- **The `--delete-branch` flag CLOSES the stacked PRs, it does not just "close" them cleanly.** If a PR's base branch is ANOTHER feat branch (e.g. the PR base = feat/slack-channel-request-workflow), and you merge the parent PR with `gh pr merge ... --delete-branch`, the base is deleted and the child PR automatically becomes `state=CLOSED` -- AND `gh pr reopen` gives a "Cannot open the pull request" error AND `gh pr edit --base main` gives "Cannot change the base branch of a closed pull request". Solution: open a new PR from the same head branch (`gh pr create --base main --head <branch>`). The earlier review history stays on the old PR -- link it by reference ("Re-opened after the prior PR closed when its base branch was deleted").
- **The orchestrator install is branch-stuck**: the orchestrator agent's local git checkout accidentally gets stuck on the feat branch during rebase conflict resolution (e.g. after `git push origin tmp:feat/X --force` from `tmp-pr-rebase` the checkout stays in place). The update.sh `Guard 1: refuse non-main branch` catches this, and `update.sh` exits -- but the dashboard UI lists `pending commits`, and the "Update now" button makes it look as if you are "on the latest version". Diagnosis: `git -C <project-root> branch --show-current`. Solution: `git stash push -u`, `git checkout main`, `git pull --ff-only`, `git stash pop`. Then build + restart.

- **The `npm run build && stop && start && stash pop` chain gets SIGKILL/exit-137 OOM.** Do NOT chain the manual post-merge update flow into one shell call (the tsc build is memory hungry, and memory accumulates during the chain → exit 137, build unfinished, services down). Correct: each step in a SEPARATE call (1: build, 2: stop, 3: start, 4: stash pop). The canonical way is `update.sh` anyway, which does it correctly in sequence.

- **`stop.sh` UNLOADs the launchd job → KeepAlive does NOT bring it back automatically.** In `com.<slug>.dashboard.plist` `KeepAlive=true`, BUT `stop.sh` stops with `launchctl unload`. An unload is a DELIBERATE stop, KeepAlive only restarts on a CRASH, NOT on unload. So after stop.sh the main agent stays down until `launchctl load` (start.sh) loads it back. LESSON: if you run `stop.sh` manually during an update, ALWAYS run `start.sh` afterwards yourself, don't wait for the operator. IMPORTANT: `stop.sh` DELIBERATELY does NOT stop the sub-agents (only the `${SLUG}-channels` main session -- explicit comment in the script). If the sub-agents are still down after the update, that is NOT because of stop.sh, investigate separately; recover one by one: `POST /api/agents/<name>/start` (Bearer token) + check with `tmux has-session -t agent-<name>`.

## Verification

- After each PR: `gh pr view <N> --json state,mergedAt` -> MERGED or CLOSED
- At the end: `gh pr list --limit 10` -> none of the PRs to be merged should be in the list
- At the end: `npm run typecheck && npx vitest run` on the fresh main -> all green
- At the end: `git log --oneline -10` -> every PR's commit is there on main

## Example

If the user writes: "there are 8 PRs, go in order, review and merge", and 3 in a row conflict (because each edits `src/web.ts`), the time estimate is ~3-5 minutes per PR with a conflict, ~30 s per PR for a clean merge. Send a progress update at 50%, so the user knows you are making progress.

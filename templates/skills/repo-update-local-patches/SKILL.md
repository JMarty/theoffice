---
name: repo-update-local-patches
description: Safely run a git pull on the marveen dashboard repo (which tracks an upstream we don't own) when there are local patches that must survive. Use when Owner says "update the repo", "git pull", "there's a new commit", or asks marveen to do the update. Covers the local-patches/ auto-reapply system, conflict resolution, dist rebuild, dashboard restart, and verification.
---
# Repo update with the local-patches system

## When to use
- Owner asks to update / pull the repo at <old-install>.
- A new upstream commit exists and local source patches are in play.

## Key architecture (READ FIRST)
- The repo tracks an upstream project Owner does NOT own. He pulls; we never push.
- Local source fixes live as patch files in `local-patches/*.patch` + `apply.sh` (a guard) + `README.md`.
- `apply.sh` is wired into `.git/hooks/post-merge`, `post-rewrite`, `post-checkout`, AND `marveen-dashboard.service` ExecStartPre. So a `git pull` AUTO-REAPPLIES the patches via the hook.
- Each patch has a SENTINEL in apply.sh `check_sentinel()` (a grep string proving it's applied).
- The dashboard runs from `dist/` (compiled), service = `marveen-dashboard.service` (systemd --user). Channels = `marveen-channels.service`.
- `agents/` and `.secrets/` are **gitignored** — a pull never touches the agent builds, configs, or keys.

## Procedure

### 1. Assess (read-only)
```bash
cd <old-install>
git fetch origin
git log --oneline HEAD..origin/main          # incoming commits
git diff --stat HEAD..origin/main            # files the pull will change
git status --porcelain | grep -vE '^\?\?'    # local TRACKED modifications
# overlap = conflict candidates:
comm -12 <(git status --porcelain|grep -vE '^\?\?'|sed 's/^...//'|sort) <(git diff --name-only HEAD..origin/main|sort)
```
The locally-modified tracked files are the RESULT of apply.sh from a prior pull (not hand-edits). Files in BOTH lists are where the patch reapply may fail.

### 2. Back up (safety net)
```bash
git diff > /tmp/local-tracked-patches-pre-update-$(date +%s).patch
```

### 3. Pull
The post-merge hook reapplies patches automatically. With a dirty tree, `git pull` aborts ("local changes would be overwritten"), so stash first:
```bash
git stash push -m "marveen-pre-update-$(date +%s)"   # NOTE: NOT -u=false (invalid flag); default already excludes untracked
git pull --ff-only origin main                        # hook runs apply.sh -> reapplies patches
```
Watch the `[local-patches]` output: each patch logs `ok/applied/FAILED`. A FAILED patch saves `.rej` files.

### 4. Resolve any FAILED patch
For each `.rej`, decide:
- **Upstream solved it natively?** (the BEST outcome) — check if the new upstream code already provides the patch's intent (e.g. 2026-05-29: our DASHBOARD_EXTRA_ORIGINS patch failed because upstream shipped `DASHBOARD_PUBLIC_URL` doing the same thing). If so, RETIRE the patch per README "Removing a patch": `mv local-patches/000X-*.patch /tmp/...`, delete its `check_sentinel()` case in apply.sh, switch `.env`/config to the upstream mechanism, delete the `.rej`.
- **Still needed?** — manually apply the change to the new upstream file (the `.rej` shows the exact hunk), then regenerate the patch file (README "Adding a patch": local commit → `git format-patch <upstream-sha>..HEAD -o local-patches/` → `git reset --hard <upstream-sha>`).
  - **MULTI-FILE / NEW-FILE / CROSS-PATCH sets: generate via a CLEAN GIT-WORKTREE, not the in-place baseline dance.** (2026-05-31: packaging patch 0007 in-place re-applied a 0006 hunk to a shared file + created `.rej` files — caught + recovered via `git checkout`+`apply.sh`, but fragile.) Use `git worktree add /tmp/wt <upstream-sha>`, apply changes there, `git -C /tmp/wt format-patch ...`, then `git worktree remove`. Zero surgery on the live tree, no cross-patch tangle. AND before any LIVE-box restart that follows a tree mishap, REBUILD dist fresh from the verified-clean tree so the restart loads known-good code.
- Do NOT `git stash pop` the pre-pull stash — it's against OLD upstream and will conflict massively. The hook already reapplied patches against NEW upstream; the stash is just a fallback. Drop it once verified: `git stash drop`.
- Clean leftover `.orig`/`.rej` files (move to /tmp). These are the "things got mixed" residue from prior conflicts.

### 5. Rebuild dist (MANDATORY)
apply.sh only rebuilds dist when it APPLIED a patch this run. If all patches were already present (skipped), dist is NOT rebuilt — but the new upstream src/ still needs compiling. Always build explicitly:
```bash
npm run build > /tmp/post-pull-build.log 2>&1 && echo OK || tail -20 /tmp/post-pull-build.log
```

### 6. Restart + verify
```bash
systemctl --user restart marveen-dashboard.service
sleep 4
systemctl --user is-active marveen-dashboard.service
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/agents   # 9 agents?
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/schedules # enabled count?
# verify surviving patch sentinels:
grep -q prepareSessionForDelivery src/web/agent-process.ts && echo 0001-ok
grep -q CLAUDECLAW_STORE_DIR src/config.ts && echo 0002-ok
```
If a patch added a CSRF/origin behaviour, test it: `curl -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://<public-host>' -H "Authorization: Bearer $TOKEN" .../api/memories -d '{...}'` → expect 200, not 403.

### 7. Tell agents to self-check
Broadcast: update done, sessions NOT restarted, do a quick self-check, report ONLY if broken. Agents are decoupled (separate claude processes) — the dashboard restart only blips the APIs they call. Silence = healthy.

### 8. Report to Owner (English, direct Bot API), then drop the stash.

## Pitfalls
- **`git stash push -u=false` is INVALID** — `-u` takes no `=value`. It prints help and does nothing; the pull then aborts. Use plain `git stash push -m "..."` (default already excludes untracked).
- **dist not auto-rebuilt when patches skip** — always `npm run build` explicitly after a pull (see step 5).
- **Never `git stash pop` the pre-pull stash** — it's against old code; the hook already reapplied patches against new code. Stash is a fallback only.
- **A FAILED patch may mean upstream solved it** — check before fighting the conflict. Retiring a redundant patch is the cleanest fix and prevents future conflicts.
- **agents/ + .secrets/ are gitignored** — never at risk from a pull; don't worry about the Ryan build / keys / configs.
- **Telegram replies to Owner: use direct Bot API** (channels/telegram/.env token) during/after a dashboard restart — the plugin can silently fail.
- **Authoring a NEW multi-file / new-file patch: do NOT use the in-place baseline dance** (git checkout the tracked files → apply.sh → diff → restore). On a cross-patch set (files touched by several patches + brand-new files + a test modified across patches) it RE-APPLIES already-present hunks to files you didn't revert (corrupted agent-process.ts during the 0007 build, 2026-05-31). Use a **clean `git worktree`** instead: `git worktree add --detach /tmp/wt HEAD`, apply 0001..N-1 there to make the baseline, `diff` that vs your live tree to produce the fold-only patch (new files → `--- /dev/null`), then `patch --forward --dry-run` to verify it applies on a fresh baseline + reconstructs your tree byte-identical. Zero live-tree surgery, zero corruption risk.

## Verification
- `git rev-parse --short HEAD` == the target upstream sha
- `npm run build` succeeds; dashboard service `active`
- /api/agents returns all agents; /api/schedules returns expected enabled count
- Surviving patch sentinels grep-positive; retired patches gone from local-patches/ AND apply.sh
- No `.rej`/`.orig` left in src/
- Owner informed; pre-pull stash dropped

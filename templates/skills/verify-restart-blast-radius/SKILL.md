---
name: verify-restart-blast-radius
description: Before stopping/restarting a systemd service that hosts tmux-based agents (dashboard restart, repo-update, migration cutover), OR when diagnosing why a service restart killed agents, verify whether the restart will nuke the tmux server. Checks the tmux SERVER cgroup vs the service cgroup + KillMode. Use whenever a restart "took down the whole fleet" or before any dashboard/service restart on a box running marveen agents.
---
# Verify restart blast radius (will a service restart kill the tmux fleet?)

## When to use
- Before any `systemctl restart/stop` of a service that spawned tmux sessions (the marveen dashboard, a migration cutover, repo-update which restarts the dashboard).
- When a restart unexpectedly killed agents and you need the ROOT CAUSE, not a guess.
- On a new box / migration, to confirm the agent tmux server is decoupled from the dashboard lifecycle.

## The mechanism (why this happens)
If the service spawns tmux via a plain `tmux new-session` (no scope isolation), the long-lived `tmux: server` daemon inherits the service's cgroup. With the systemd default `KillMode=control-group`, restarting the service SIGTERMs the entire cgroup, kills the in-cgroup tmux server, and every session attached to it dies — even sessions for unrelated agents. Confirmed on marveen 2026-05-31 (see memory `dashboard-restart-kills-fleet`).

## Procedure

**Run the script — it refuses instead of guessing:**
```
~/.claude/skills/verify-restart-blast-radius/check-blast-radius.sh [socket] [service]
# defaults: theoffice theoffice.service
# exit 0 = SAFE (fleet survives) | 1 = UNSAFE (restart kills the fleet) | 2 = CANNOT DETERMINE
```
It selects the server BY SOCKET, asserts `comm` is literally `tmux: server` (so it can never match your
own shell), refuses if the server owns no real sessions (the empty-husk false all-clear), cross-checks
that a live pane actually parents to that server, then compares cgroups + KillMode. **Every ambiguity is
exit 2, never a best guess** — the manual version's failure mode was returning a plausible pid.

**Read the exit code WITHOUT a pipe.** `check-blast-radius.sh ... | head` sets `$?` from `head`, not from
the script — you get `0` no matter what the checker decided. This bit a careful reader on 2026-08-01 who
briefly concluded the gate was broken when it was working correctly; the instrument lied, not the tool.
Run it bare and read `$?`, or capture with `out=$(script ...); code=$?`.

Exit codes: `0` SAFE · `1` UNSAFE (restart kills the fleet) · `2` a fleet EXISTS but its blast radius is
unreadable — refuse · `3` NOTHING TO PROTECT (no server, or an empty husk) — proceed, safe by construction.

**A `CANNOT DETERMINE` (exit 2) is NEVER licence to fall back to eyeballing pids.** It is licence to find
out *why*. The manual procedure is what produced three confident wrong answers in one day; reaching for it
because the script declined re-introduces exactly the failure the script exists to prevent. Check, in order:
the server may use `-S /path/to/socket` rather than `-L name` (pass the full path as the socket argument);
the service may simply not be running; or the fleet may genuinely be on a different socket than you assume —
`ps -eo pid,comm,args | grep 'tmux: server'` to list ALL servers, then re-run the script per socket.

Only fall back to the manual steps below if the script cannot run at all:

1. Find the tmux SERVER daemon (comm is `tmux: server`, NOT the transient `tmux new-session` client):
   `ps -eo pid,comm,args | grep 'tmux: server'`
2. Read the server's cgroup:
   `cat /proc/<server-pid>/cgroup`
3. Read the target service's cgroup + KillMode:
   `systemctl --user show <svc> -p MainPID -p KillMode` then `cat /proc/<MainPID>/cgroup`
4. VERDICT: if the tmux server's cgroup == the service's cgroup AND KillMode is `control-group` (or unset → defaults to control-group), then **a restart WILL kill the whole fleet**. If the server is in its own scope/service cgroup, it's safe.

## Pitfalls
- **The pane `tmux-spawn-*.scope` cgroups are a RED HERRING.** Individual panes get their own scopes and look decoupled — but panes cannot outlive their server. Always check the SERVER's cgroup, not a pane's. This exact trap caused a wrong "it's safe / mechanism unconfirmed" retraction during the marveen incident before the server cgroup was checked.
- `pgrep -x tmux` matches the transient new-session client (comm `tmux`), which may have already exited — it does NOT find the server (comm `tmux: server`). Use `grep 'tmux: server'`.
- **`pgrep -f` / `grep` on the ARGS can match the QUERIER, not the server.** `pgrep -a -f "tmux: server"` matches any process whose command line contains that string — *including the shell running your own check*. Both failure modes hit on 2026-08-01: one returned a transient client, one returned the querying bash process. **The false positive looks like a plausible pid, not like an error**, so it silently poisons the cgroup check that follows. ALWAYS confirm a candidate pid with `ps -o comm= -p <pid>` and require it to read exactly `tmux: server` before reading its cgroup.
- **There can be MORE THAN ONE tmux server — one per socket — and the decoy may own NOTHING.** On this box: the agent fleet is entirely on `-L theoffice` (server <id>, all ten `agent-*` sessions); the **default socket holds only `__keepalive`** (server 339, zero agent panes). Corrected 2026-08-01 — an earlier version of this note had that backwards and called 339 "the fleet". That error runs in the **dangerous direction**: you check an empty husk, watch it survive a bounce, and report the fleet safe on the strength of a server holding nothing. **A false ALL-CLEAR is worse than a false alarm.** Select by socket, then require the pane-parent check to agree: `ps -o ppid= -p <pane_pid>` must return the server you think you checked.
- **Prefer the script to the procedure.** Three wrong pids were produced on this check in one day by two people who both knew the traps (a transient client, a querying shell, an empty-husk server). Each returns a *plausible pid* rather than an error, so the wrong answer is indistinguishable from the right one. A procedure followed correctly most of the time is not good enough for a check that gates fleet-killing restarts.
- A flip-flopping diagnosis means STOP and verify with `/proc/<pid>/cgroup` yourself before broadcasting to the team — don't whipsaw everyone on a hypothesis.

## Fix directions (if unsafe)
- Minimal: set `KillMode=process` on the service unit → only the node MainPID is killed on restart; tmux server + panes survive. Verify the re-started service re-attaches cleanly and assumes no fresh server.
- Robust: spawn/own the tmux server in its own systemd scope (`systemd-run --scope`) or a dedicated user service, fully decoupling it from the host service lifecycle.
- **Cutover trap (own-scope fix on a box with an existing in-dashboard server):** there is ONE tmux server per socket. If the old server is already running on the default socket, `systemctl start <new-tmux-unit>` (which runs `tmux new-session`) just ATTACHES to the existing old server — it does NOT create a new owned one, so the server stays in the old cgroup and the fix SILENTLY NO-OPS. You must `tmux kill-server` the old one FIRST, then start the new unit (fresh server forks into its cgroup), then respawn sessions. This is a ONE-TIME FULL bounce. And it CANNOT be driven from inside a tmux pane — killing the server kills the executor's own session mid-script; run it from a detached shell / systemd oneshot.

## Verification (acceptance)
Empirical, mechanism-agnostic: perform a controlled restart in a safe window and confirm the tmux server + a live test agent are STILL ALIVE afterward. This gate holds regardless of the suspected mechanism.
- **Assert the SERVER pid's cgroup, NOT a pane's.** When validating an own-scope fix, the load-bearing check is `cat /proc/<tmux-SERVER-pid>/cgroup` == the new owning unit. Do NOT assert the test agent's PANE cgroup: panes live in independent `tmux-spawn-*.scope` units regardless of which server owns them, so "pane not in the old cgroup" is TRUE in both the fixed AND the broken no-op-cutover state — it cannot discriminate and will silently pass a botched fix. The server-pid cgroup assertion fails loudly on a no-op cutover.
- **If the fix relies on a keepalive (tmux `exit-empty` on):** also drain ALL agents/sessions and assert the server PID PERSISTS. A one-shot restart test never exercises the last-reap path where a failed keepalive silently kills the owned server.
- **Survival != success:** assert the recovered/surviving agent actually FUNCTIONS (answers a message, single-poller, zero 409), not merely that it appears in `tmux list-sessions`.

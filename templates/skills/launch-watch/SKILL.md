---
name: launch-watch
description: Post-launch watch for an app/event/announcement the owner just put live - Slack channels + the launch thread + DMs to him + in-app feedback + change requests + email + usage numbers, reported ONLY as new items via a seen-ids diff, run as a scheduled heartbeat (never a foreground poll loop). Use when Owner says "keep an eye on it for N hours/days", "watch the Q&A", "tell me if anyone reports a bug", after any app launch (Split, an event, Strategy Day, the company portal) or a live session (All Hands Q&A).
---
# Launch watch (new items only, scheduled, self-retiring)

Built from the Split launch (2026-09-30 .. 10-18): scheduled tasks `split-launch-watch-24h`, `split-launch-first-hour-0930`,
`qa-launch-watch-3h`, `qa-live-watch`, `split-feedback-meetup-watch` in `/opt/claude/theoffice/tenant/scheduled-tasks/`, and
the non-Slack check script `agents/marveen/split-app-content/launch-watch/check.sh` + `state.json`.

## Mikor használd
- Right after a launch post / go-live, when the owner asks for a watch window, or for a live session (10-min cadence).
- Any recurring "only tell me what's new" check (Q&A questions, feedback, bookings, sign-ups).

## Eljárás
1. *FLEET RULE 1: never sit in a foreground loop.* Create a scheduled task (heartbeat type = silent unless new) via
   `POST /api/schedules` or a folder in `tenant/scheduled-tasks/<name>/` (SKILL.md + task-config.json). The runner reads
   ONLY the tenant copy (memory the-runner-reads-only-the-tenant-copy). Cron is Budapest time.
   Cadence used: first-hour one-off (`10 19 30 9 *`, type task, always reports, disables itself), launch 24h then 3x/day
   (`0 9,14,19 * * *`), Q&A every 3h (`0 9,12,15,17,18,21 * * *`, weekend 2x), live session (`*/10 15-16 12 10 *`).
2. *Task SKILL.md skeleton* (copy from `split-launch-watch-24h`):
   - FIRST `date`; an explicit END condition ("after <date> Budapest: one line to the owner, set enabled=false, stop").
     If the end date is my assumption, say so to the owner.
   - State file path; read it first, write it last, append one line to `runs[]` with what was checked INCLUDING the
     negatives ("meetup ch 0, DMs 0, CRN ok, usage unchanged (not reported)").
   - Sources, every run (all of them, numbered):
     a. Slack channels since `slack_last_ts` (MCP `slack_read_channel`), and the launch post's FULL thread
        (`slack_read_thread` on its ts; store `launch_msg_ts`). Add each later announcement thread by ts.
     b. DMs to the owner (`slack_search_public_and_private`, to:me / is:dm). THREAD RULE: before surfacing a DM/thread
        item open the full thread; if Owner already answered, drop it (to:me never shows his replies; owner 10-07).
     c. In-app feedback export (Bearer token from `tenant/secrets/<app>/feedback-read.token`) -> seen-ids diff.
        A real bug also goes to darryl on the bus (one line + file if long).
     d. Change requests / bookings / sign-ups exports -> seen-ids diff; check the notifier's `last-run.json` has no
        error and is fresh.
     e. Email: all 5 inboxes newer than `email_last_epoch` (gmail-multi-inbox-check route); real human mail only.
     f. Usage export (unique sign-ins, installs, opens/day, who has NOT opened vs roster): only in 2 runs/day and only if
        changed.
   - Output: Nothing new = SILENT. New = ONE office-say, Slack mrkdwn, "*Launch watch HH:MM* N new:" grouped by source,
     each item who + what + what I did. Bugs first. Privacy: question/feedback text only to Owner.
3. *One check script for the non-Slack sources* (Slack stays on MCP). Pattern: `check.sh` prints `date`, the state
   cursor, then one line per NEW item per source. Use the shared diff helper instead of re-writing it per watch:
   `curl -s -H "Authorization: Bearer $(cat $TOK)" $URL/api/feedback/export | python3 -I ~/.claude/skills/launch-watch/seen_diff.py $STATE feedback_seen_ids --list-key rows --fields id,sender_email,kind,blocks,page,text`
   Run without `--commit`, report, then run again with `--commit` (a run that dies mid-way does not swallow items).
   Exit 2 = the export did not return the expected JSON (auth wall, outage): report the source as UNREADABLE, never as
   "nothing new".
4. *Retire*: at the end condition send the one-line close ("Q&A watch done: N questions total"), set `enabled: false`,
   and confirm by reading the file back. A one-off that fired is spent, not coverage (memory enabled-is-not-armed).

## Buktatók
- Token cost: the owner rejected AI heartbeats for pure watching (PersonBD visit watcher 10-29). If the source is an API,
  prefer a no-AI script on a systemd timer that wakes an agent only on new rows (`darryl/work/haris-demo/tools/visit_watch.py`).
  Use an agent heartbeat only when judgement (Slack/DM/email triage) is needed.
- `skipIfBusy: true` for 10-minute live watches, otherwise a busy agent queues a backlog of runs.
- Missing token file = the feature never shipped: tell the owner once and disable, do not guess counts.
- Do not report usage numbers every run; he wants them only when they move.
- Leadership channels (e.g. #people-ops <slack-id>): surface only to the owner, never to other agents or shared memory.
- Ignore his own messages and bot noise; reaction-only replies are not items.

## Ellenőrzés
- Task file has a start, an END condition, a state file, every source numbered, "silent when nothing new".
- After a run: state cursor advanced, `runs[]` has a line with the negatives, seen ids committed only after the report.
- At the end: enabled=false read back from disk and the owner got one closing line.

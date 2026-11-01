---
name: app-usage-watch
description: Add usage/visit tracking to any web app, demo or client portal we ship (who opened it, what they did, on which device, errors), tell real users apart from us (owner, partner, our QA), and watch it with a no-AI timer that wakes an agent only on something new. Use when building or launching an app/demo/portal, or when the owner asks "do people use it / how do they use it / how to make it better". Reuse this, do not reinvent it.
---
# App usage watch (track -> classify -> export -> no-AI watch -> owner report)

Distilled from four builds that work: an event app (track() beacon plus an admin usage export), a second event app (POST /api/usage plus a token-guarded export), two server-log watchers (a no-AI timer script that wakes an agent on something new) and a client portal (an events table with an actor column).


## 1. Track (client side)
- One fire-and-forget beacon: `fetch('/api/event', {method:'POST', credentials:'same-origin', keepalive:true, body:{kind, detail}})` wrapped in try/catch; the app must work if the log fails.
- Kinds that answered every owner question so far: `link_open`, `session_start` (+ end / time on page), `tab_view` (debounce one per tab per 30 s), `click` (named targets: maps, transfer link, Másolás, upload...), the app's key actions (upload, submit, answer, skip, forward), `error` (window `error` + `unhandledrejection` + API 4xx/5xx with route).
- Store per event: id, ts, who (person id / link id / deal id), actor, kind, detail (short, max ~20-60 chars, NEVER content the user typed), device (phone/desktop + OS/browser), country. IP only if needed for de-duplication, never shown.

## 2. Classify: real user vs us (the part that always bites)
- Every row gets an actor: `owner | partner | staff | qa | client`. Decide SERVER-SIDE: same-origin admin/CRM session cookie = owner/partner/staff; preview links = owner; known test accounts and our server IP/bot UAs (curl, python, playwright, headless) = qa. No marker = the real user.
- Strategy Day lesson: Darryl's screenshot QA used real people's links and looked like real opens (alari 10-30). Mark QA at write time (actor) instead of excluding windows by hand afterwards (`_qa_ignore_after` was a patch).
- The organiser/owner's own clicks must never count as adoption (`organiser` flag in Strategy Day).

## 3. Export (agent read)
- `GET /api/admin/usage?since=<iso>` (or since-id), Bearer token in the HEADER (never in a URL or message), constant-time compare, wrong token = 404. Return raw rows + a per-person summary (first_open, last_seen, visits, tabs, clicks, errors, devices) that already excludes non-client actors.
- KV storage: per-user keys (`usage:email:<x>`), never one shared read-modify-write blob (Split race Toby caught).
- NO usage UI in an owner screen the partner might see (owner 2026-11-01: he screen-shares with Laci).

## 4. Watch (no AI unless judgement is needed)
- A systemd timer script (every 5-10 min), not an agent heartbeat (owner rejected AI polling for pure watching, Haris 10-29). It reads new rows since its cursor, drops non-client actors, and reports EVERY client session, not only the first (owner 2026-11-01: "Dont just track first usage. But all of them. Make it as token free as possible"): after ~20 min idle one formatted step list per session (who, deal, device, duration, steps, errors), plus stalls (opened, nothing done for 48 h).
- TOKEN-FREE: the script formats the report itself and posts it straight to the owner's Slack (office-say equivalent / Slack API) and appends it to a log file. It wakes an agent on the bus ONLY for things that need judgement or action: errors (darryl) and stalls/answers that need a next step (marveen). A routine session report never costs an LLM turn.
- Agent-side daily/launch reports use `launch-watch` (state file, seen-ids, only what changed).

## 5. Report to the owner (what he actually wanted)
Only when something changed: who opened for the first time, who has NOT opened yet (name them), which tabs/steps people really use, phone vs laptop, taps on key buttons, errors with a fix suggestion, and ONE concrete "make it easier" idea when the data supports it. Keep owner/partner/QA activity out of the numbers, or show it separately labelled.

## Buktatók
- Deploy tracking BEFORE the links go out: Strategy Day links went out 16:24, tracking 16:25, and the early opens were lost for good.
- A beacon that throws breaks the app: always try/catch, keepalive, no await.
- Never log free text the user typed (answers, notes, file names are client data; file names only as counts/types).
- Two silent reads of a flaky export are one observation: an unreadable export is reported as UNREADABLE, never as "nobody used it".

## Ellenőrzés
- Three test sessions (owner, partner, client) on one link produce three actors in the export.
- The per-person summary excludes owner/partner/qa rows.
- The watcher fires once on a client's first open and stays silent for owner/partner visits.

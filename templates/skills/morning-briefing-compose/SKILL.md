---
name: morning-briefing-compose
description: Compose the owner's daily morning briefing as a SYNTHESIZED mental map, not a data dump. Use when the morning-briefing scheduled task fires or the owner asks for the briefing. Brief by meaning, not by source - conclusions, connections across sources, only what changed or needs the owner. Mandatory pre-flight and pre-send gates prevent the known drift failures.
---

# Morning Briefing Compose

## The philosophy (read first, this is the whole point)
Brief the owner by **meaning, not by source**. Do not list his mail, then his calendar, then his agents. Hand him **conclusions**: the state of his world, what only he can move, what you already handled, and the connections he would otherwise have to make himself. Collect everything, but only conclusions reach him. The briefing installs a mental map of the day; it does not prove you read everything. Completeness in collection, ruthless judgment in what is surfaced.

If a line could have been produced by just sorting raw data, cut it. Every line is either a judgment only someone who saw all the sources could make, or a decision he owes today.

**The one absolute exception: ruthlessness applies to information, never to an ask.** A direct question from an agent to the owner is never compressed, never deferred, never summarised away. It goes into "Needs you today" in the agent's own words.

Why this needs saying: an unurgent question reads exactly like the low-value line this skill tells you to cut (no deadline, no number, nothing changed since yesterday), so cutting it feels like good judgment every time and is wrong every time. A question only he can answer is by definition a decision he owes today; the agent already applied judgment by asking. The drop is also silent (compose keeps no record of what it left out), which is why it repeats. So, before sending: re-read every board section and confirm that each question mark and each explicitly flagged question appears in the briefing. If you deliberately hold one, tell the agent who asked, in the `result` when you close their message. Never just drop it.

## When to use
- The `morning-briefing` scheduled task fires. The fire time can be dynamic (an arming task can move the cron to "next alarm + 30 minutes"); composing late is correct, not a glitch.
- The owner asks "send the morning briefing" or "what's on for today".
- After a correction where the previous briefing was wrong.

## The eight intelligence behaviors (what makes it a synthesis, not a reorganised list)
1. **Cross-source linking (the killer move).** Fuse a calendar event, the email behind it, the finance number it concerns and the agent who flagged it into one insight. Never report the same thing in three sections.
2. **Think one move ahead (consequence chains).** Not "payment landed" but "landed, so the transfer runs tomorrow and the bill clears Friday; if it slips past Wednesday the chain moves a week". Surface the next action a fact creates.
3. **Delta over state.** Report only what changed since yesterday or needs action. An area that did not move gets zero lines. A quiet day is a short briefing, and that is a feature. Keep a snapshot of what you surfaced today so tomorrow can compute the delta.
4. **Organize by the owner's own areas, not by inbox.** Use the units he thinks in (ventures, projects, household, finance, health, family). Cluster all cross-source data into the area it belongs to.
5. **Read all inboxes fully, surface everything important, count-and-collapse the tail.** Not a "top 5". Open the body of every non-promo message, surface every genuinely actionable item in its area (or in Needs-you), then collapse the rest into one honest line that proves completeness ("28 mails across all inboxes; everything needing you is above; 24 others triaged, nothing pending").
6. **News only with a vector into his world.** Format: "what happened, so for you it means X". A generic headline he would see anyway is cut.
7. **Predigest agent reports into "so what for you".** Never paste an agent's status. Translate to implication plus decision. Surface an agent only if its output has an implication for the owner.
8. **Risk and opportunity flags (max 2-3, each tied to an action).** Force-rank what could go wrong plus one thing worth grabbing. Tie each to a next step, not to awareness.

## A) Data collection (gather wide, then synthesize)
0. **Read the briefing board first**, before pinging anyone: `GET /api/briefing-board` returns `{sections:[{section_key,agent,content,age_sec,fresh,status}], missing:[], stale:[], complete}`. It tells you which agent sections are in and fresh.
1. `date`, and `date -d "YYYY-MM-DD" +%A` for every date you will mention. Never guess a weekday.
2. Overnight reflection output (the dream engine's file), if present. If it says "skipped", run it live; never relay "skipped".
3. **Ping the agents first**, before the slow collection, so replies are ready by compose time (inter-agent latency is about 3-4 minutes). Use the real agent ids from the roster; a wrong id sits pending forever.
4. Local sensors for weather and home state (the home-automation connector), never a web weather API.
5. **Calendar: a fresh live pull on every run** (today plus the next 7 days, every calendar). Late-added same-day events are the number one miss. If you did not call the calendar this run, you have not checked it. Show events as START-END.
6. **Mail: every inbox, a full ~30 hour window** (Gmail `newer_than:` has no hour unit, so use `after:<epoch>`). The primary inbox's main and updates categories are read in full; never collapse an order, receipt, delivery, appointment or bank item into the tail unread.
7. **News**, last 24 hours, a few local and a few international sources; keep only what passes behavior 6.
8. Kanban (urgent and high cards) and pending agent messages (poll right before composing).
9. **Service health**: read `store/service-health.json` (written by the service-health timer). Turn it into a positive assertion ("all N units healthy") or name the unhealthy ones. If the file is missing or `checked_at` is older than twice `interval_s`, say so loudly: the detector itself is down.
10. Parking-lot items with their ages; nudge the ones that are due.

## B) Compose
Plain text, light Slack mrkdwn (single-asterisk bold). Omit any empty section entirely.

1. **Today's shape**: the lede. One or two sentences: the day's center of gravity, the load (light/normal/heavy) and the single must-not-miss. Take a point of view.
2. **Needs you today**: hard cap about 3-4. Only where the owner is the bottleneck and a decision or reply is genuinely owed today. Each carries enough context to decide from a phone (numbers, the ask, "say go and I do X"). Deduplicate email, chat, finance and parking-lot deadlines into this one list.
   - **Verify gate before any deadline, official or approval item enters this list.** An item relayed by an agent or a card is an input to verify, not a fact to relay. Run the precheck tool first: `python3 $OFFICE_TENANT_ROOT/tools/needs-you-precheck/needs_you_precheck.py "<case number or subject keywords>"`. `RESOLVED` is safe to drop. `REVIEW` is not a drop: confirm against the sent mail or the source and drop only on positive confirmation. `OPEN` is surfaced. Bias is deliberate: a false OPEN (still surfaces) beats a false RESOLVED (hides a real need).
   - **Owner-action only.** Is the ball on the owner, or on a third party (an authority, a vendor reply, a booking system)? A "waiting" card can mean either. Waiting-on-third-party is not a need-you: at most a mention in its area line.
3. **Your world**: the mental map, clustered by area. One short line per area that moved, fusing calendar, mail, finance, agents and relevant news (behaviors 1, 2, 4, 7). Weave today's calendar events into the area they belong to, with start-end and travel time. Consequence chains and risk/opportunity flags live here.
4. **World**: the relevant news lines (behavior 6). Skip if nothing passed the filter.
5. **Inbox sweep**: the count-and-collapse line proving every inbox was read.
6. **Handled and fleet**: one line of what the agents or you closed overnight (it builds the trust that lets you cut), plus fleet exceptions only. "Fleet green" if nothing is notable.
7. **Overnight reflection**: lead with a one or two sentence plain-language summary of the dream engine output, then one or two key points. Mandatory whenever the file exists.
8. **Sign-off**: a rotating bit from the persona's own deck (SOUL.md). A different one each day.

Short emoji headers are fine if they help scanning. Length discipline: fit one phone thumb-scroll on a normal day.

## B1) Completeness preconditions: do not compose until both are true
The recurring failure is rushing the collection, which breaks two things at once: composing before agent replies land (forcing addenda), and reading email subjects instead of bodies. They are linked: agent replies take a few minutes, and reading every body properly takes about the same few minutes. So ping first, do the slow collection while the replies land, then check.
1. **Agent sections are in.** Poll pending messages and read each agent's pre-written section (finance, work, car/weather, infrastructure). If one is not there yet, wait and re-poll (bounded, about 5 minutes from your ping). Their answers belong in the briefing, never in an addendum after it.
2. **All inboxes swept, bodies opened.** Actionable items reach the owner only from an opened body. "I did not fully sweep the others" is a fail, not an honest caveat: finish the sweep or do not send.

## B2) Pre-send verification gate (mechanical, not a reminder)
Before sending, re-read every owner-facing line. Each must trace to something you opened or pulled this run. Relaying a raw source item at face value is the failure (a listing "expired" read off a subject when the body said it stays active; figures from an old cached memory; an invite surfaced as an action when it was already handled).
- **Email**: the body was opened this run (plus the PDF if the detail is there). Never surface off a subject or label. A qualifier in the body can flip the meaning.
- **Figure or state**: pulled live this run, or explicitly stamped "as of <date>". Never a cached memory presented as current. If an agent's pushed section carries an "as of" stamp, verify it reads today; if not, pull live.
- **Action item**: cross-checked against what the fleet already did. Handled or superseded is not an action.
- Anything you cannot verify live: drop it or hedge it clearly. Fewer true lines beat more lines with holes.

## C) After compose
- Send as one plain-text message through the language gate your install uses (for example `OFFICE_SAY_ENGLISH_ONLY=1 office-say "..."`); split only if length truly forces it. Pick the briefing language once and keep it for the whole message, even when sources are in another language.
- Write a fresh snapshot of today's surfaced facts (balances, open bills, area states, calendar) so tomorrow's run can compute the delta.
- Mark the agent ping replies done in the queue.
- Do not double-send: if a briefing already went out this morning, check the message history before firing another.

## Pitfalls (hard-won)
- A synthesis, not a dump. If you catch yourself listing a source's contents, stop and re-cluster by meaning.
- Weather comes from the local sensor. Weekday names from `date -d`. Calendar times as START-END.
- Plain text only. No backticks around URLs or paths in chat (a copy picks up the backtick and breaks redirect URIs). No em dashes.
- Duplicate fires: if two briefings appear, list the timers (`systemctl --user list-timers --all | grep morning`) and disable the legacy one.

## Checks
- Reads as a mental map of conclusions, not a list of sources.
- Today's-shape lede present; Needs-you capped at about 3-4 with decide-from-phone context; every agent question present.
- Areas show deltas only; consequence chains where relevant.
- Every inbox swept over the full window, bodies opened; tail collapsed into one honest line.
- Service health asserted positively, or the detector's own failure called out.

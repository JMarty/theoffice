---
name: inter-agent-message-processing
description: Read and correctly close inter-agent messages addressed to you. Use on every message-inbox-check heartbeat or when delegating/replying to another agent. Prevents the silent "completed" bug that leaves messages pending forever.
---
# Inter-Agent Message Processing

## When to use
- The `message-inbox-check` heartbeat fires
- You delegated work and want to confirm/close the loop
- Any time you POST or close an `/api/messages` item

## Procedure
1. Keepalive first (heartbeat rule): `echo keepalive >> /tmp/marveen-keepalive.log`.
2. Fetch your OPEN set (to READ it - see the prohibition at the end of this step):
   curl -s -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" \
     "http://127.0.0.1:3430/api/messages?to=<me>&status=delivered&limit=500"
   `delivered` is the open bucket on this runtime. `pending` has ZERO rows in the entire
   table - the bus flips pending->delivered inside one tick - so ?status=pending is
   permanently empty and is NOT a trustworthy list, it is a tautology.
   The endpoint has no `id` parameter and caps at 500 newest rows, so DO NOT fetch your
   inbox and look for a status: an older row is simply absent, and absent does not say
   `done`.
   `delivered` on this API means an enqueue was ATTEMPTED, not handed to you (bus/index.ts:95).
   The real test is `inbound_queue.delivered_at IS NOT NULL`. The API cannot express it, so:
     id ABSENT from the open set           -> terminal. DO NOT CLOSE.
     id PRESENT                            -> an enqueue was ATTEMPTED. Not permission.
     arrived in YOUR CURRENT CONTEXT       -> yours to close.
     present, NOT in your context, and you
     cannot tell (e.g. after a reset)      -> DO NOT CLOSE AND DO NOT LEAVE IT. Take it to the
                                              SENDER. A pre-reset id goes to the sender, never
                                              to a close.
   "Arrived in my own context" is the FALLBACK for where the API cannot express the real test - it is
   not the rule itself.
   POLL TO READ, NEVER TO CLOSE.
3. For each: read content, take the right action (reply on Telegram, delegate, update kanban, or just note).
   SENDING a message to another agent: `$OFFICE_ROOT/tools/agent-msg/agent-msg <agent-id> "<message>"` (`-` reads stdin). A send counts only if the bus answered HTTP 200 with an id: the tool checks that, retries 3 times and prints NOT SENT on failure. Never infer success from `curl ... >/dev/null && echo sent` (curl exits 0 on a 401/500).
4. Close it via the **`POST /api/messages/done`** endpoint with `{id,result}` (NOT the old `PUT /api/messages/<ID>` — that path is DEAD on the Office runtime, see Buktatók):
   ```bash
   curl -s -X POST http://127.0.0.1:3430/api/messages/done \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" \
     -d '{"id":<ID>,"result":"<short note>"}'
   ```
5. DO NOT VERIFY BY THE RESPONSE. `POST /api/messages/done` returns {"ok":true,"id":<ID>}
   IDENTICALLY on a first close and on a fiftieth. It is an unconditional UPDATE
   (server.ts:592) that overwrites `completed_at` and NULLS `result`. The response
   proves a row was written, not that the write was correct or wanted.
   Never close a row that is not in your open set. Never close a row whose `to_agent`
   is not you - the handler has no authorization check at all.

## Pitfalls
- **NEVER RE-CLOSE A DONE ROW - this supersedes any older bullet below that treats `{"ok":true}` as proof of a good close.** `POST /api/messages/done` has no status guard and no authorization (`server.ts:592`): a second close overwrites the original `completed_at` and NULLS `result`, and it answers `{"ok":true,"id":<ID>}` identically every time, which is exactly why the habit felt safe. The destroyed value is often NOT bulk cleanup text - a sample of ryan's 16 result-bearing rows found 3 with real content, 2 of them his own audit trail (ids 3275, 2276); jim found the same on his. So "it was only provenance" is not a reason to skip the check. **Do not trust a `404` to mean "wrong id, fix and retry" either** (Pam, 2026-09-20): the pending engine fix may make an ALREADY-DONE row return 404, so the old retry advice would loop the destructive write onto precisely the row it must not touch. The open set is a PROHIBITION list, checked immediately before the write, and arrival in your CURRENT context is the FALLBACK permission for what the API cannot express - a message you can neither place in your context nor rule out (after a reset) goes to the SENDER, not to a close and not to the floor. Four arms, see step 2. Oscar, 2026-09-22, and **use 10%, not the 76% first circulated**: of the `delivered` rows addressed to REAL agents (a live pane) 6 of 62 = **10%** had `inbound_queue.delivered_at` NULL - never handed over - so closing on presence marks a message done BEFORE its recipient sees it, and they receive it already closed with no way to tell. All 6 were IN-FLIGHT (65-741s old), which is exactly the hazard window; 16966 was 173s old when a polling recipient closed it. The 76% figure ANDed in rows addressed to names with NO live consumer (monitors, alarms, and the aliases `michael`/`oscar` whose routing ids are `marveen`/`cfo`), which are 100% blind BY CONSTRUCTION and are the unroutable-recipient defect below, not this one. **Exclude that cohort by PREDICATE, never by a count:** `to_agent NOT IN (GET /api/agents) AND inbound_queue.delivered_at IS NULL`, **with no status filter**. The number 176 was only the ones still sitting in `delivered`; Dwight found 126 more already CLOSED (four his own), invisible to any `status=delivered` query - corrected total 303, and a reader excluding "the 176" still admits 126. A sized exclusion is outgrown the moment someone closes a row; a predicate cannot be. An agent only ever closes its OWN messages, so the denominator is real-agent rows. Quoting 76% here would misattribute that defect to this endpoint and would let a later ~10% reading be credited as a fix that was a denominator artifact. Canonical text: shared memory `interim-never-reclose-a-done-message`. Patched 2026-09-20 by ryan, wording from darryl (bus 16746).
- **Close endpoint MIGRATED (Office runtime)**: the old `PUT /api/messages/<ID>` path is DEAD on the Office runtime (the engine's `dist/index.js`) — it returns a generic 404 and the message stays **pending forever**. The live close path is **`POST /api/messages/done`** with body `{"id":<ID>,"result":"<note>"}`. A message closed via the old path stays pending. Verified live: `POST /api/messages/done` returns `{"ok":true}` on BOTH port 3420 (legacy/multi-port) and 3430 — so the port is fine, only the method+route changed. **[SUPERSEDED 2026-09-22 on the `{"ok":true}` point only — see the first bullet of this section: that response proves nothing about whether the close was correct or wanted. The route/port finding below and above stands as written.]** The `done`-only / `failed`-only status rule below still holds (the new endpoint is just the `done` action).
- **Do NOT read message state from `<old-install>/store/claudeclaw.db` directly.** That SQLite is a FROZEN legacy store (stuck at id ~2250); the Office runtime writes messages to a SEPARATE store (ids 2251+). Reading the legacy DB shows stale "pending" rows that the runtime has long since closed, and never shows new traffic. The runtime API (with its now-working filters, step 2) is the only source of truth for message state. (Shared mem 2026-06-10.)
- **`completed` is silently rejected**: `src/web/routes/messages.ts` PUT only accepts `done` and `failed`. Any other value (incl. `completed`, which the scheduled-task prompt example uses) returns `{"error":"Message not found or invalid status"}` with 404 and the message stays pending forever. 2026-05-29: marked 7 morning-briefing replies "completed", loop echoed success (it only checked curl exit code, not the JSON body) — they were all still pending. Re-ran with `done` → drained. ALWAYS read the JSON response body, not just curl's exit code.
- **Agents reply ~3-4 min late**: a status ping you send is answered via this same queue minutes later, not instantly and not on the other agent's Telegram. Poll before you rely on replies.
- **Crossing-message loops (fast multi-agent iteration)**: when you and a peer iterate quickly on a converging topic, queue latency/reordering makes messages CROSS — the peer keeps replying to your *stale* message (asking for a GO you already gave, restating an already-agreed point, "correcting" something already fixed). 2026-05-31: the restart-safety fix coordination crossed ~8x (Darryl re-requesting an implement-GO given twice; Toby re-confirming a converged runbook pin repeatedly). How to handle: (1) NEVER act on a peer message that contradicts a converged state as if it's current — it's almost certainly stale; verify (e.g. `/proc`, the file, the doc) before re-broadcasting. (2) Don't re-confirm an already-agreed state — that reply just feeds the loop. Re-deliver ONLY the actionable delta, self-contained (don't assume the peer found your earlier message). (3) To actually BREAK the loop, constrain the peer's NEXT message to a binary state-change: "your next message to me must be exactly STAGED or BLOCKED:<x> — not another confirmation." Removing the restatement removes the crossing. (4) For "standing down / no action" pings, just stop replying — silence ends the loop; tag your own closes "no reply needed".
- **Wrong recipient id** (symptom corrected 2026-09-22): messages to a bad agent_id (e.g. `oscar` instead of `cfo`, or `michael` instead of `marveen`) do NOT "sit pending" - `sendAgentMessage` (bus/index.ts:23) inserts with NO validation of `to`, the bus then enqueues for that non-existent agent and marks the row `delivered` anyway, so they sit in the **delivered** bucket forever with nothing to consume them. The old "pending forever" wording pointed at a bucket that is permanently empty, so nobody could ever see it. This is the unroutable cohort and it is a SEPARATE defect from the close rule - exclude it by PREDICATE, see the bullet above. **NEVER trust a hardcoded roster, including one in this file.** Get the ids from `GET /api/agents` at the time you send; **humans are never on it** (no owner handle, no external contact). A list written into a skill is a forward citation: it goes stale silently and nothing tells the reader. Proof, 2026-09-22: this bullet carried `andy` and `kevin` for months - neither exists (live roster: cfo, clark, darryl, dwight, jim, marveen, pam, pete, ryan, toby) - while omitting `clark`, `pete` and `ryan`. `andy` has 16 rows and `kevin` 13, all 29 never delivered. So the paragraph explaining why bad ids strand was itself handing the reader two bad ids: send to `andy`, get a success id back, strand the message, having just read why that happens.

## Verification
- The id was NOT absent from the open set, AND the message arrived in your CURRENT context. Presence alone licenses nothing - `delivered` only means an enqueue was attempted. If you cannot tell whether it reached you (after a reset), you took it to the SENDER rather than closing it or leaving it. The `{"ok":true,"id":<ID>}` response is NOT the check either; it says the same thing on a destructive re-close.
- Re-query `?to=<me>&status=delivered&limit=500` no longer lists the closed id

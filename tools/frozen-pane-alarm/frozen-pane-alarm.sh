#!/usr/bin/env bash
# frozen-pane-alarm — DETECT AND ALARM ONLY. Sends ZERO keystrokes, ever.
#
# WHY THIS EXISTS (2026-08-04). Three agents (marveen, dwight, toby) sat frozen on a Claude Code
# usage-limit modal from ~07:20 to ~11:00. The modal replaces the idle footer, so detectPaneState()
# returns "unknown", deliverClaude bails before markDelivering, and inbound parks forever with
# attempts=0. Consequences: the 06:00 briefing-arm never ran, the 08:35 briefing was queued and
# never collected, and a message from THE OWNER asking why we had gone quiet sat unread for 22 minutes.
# He found it before we did. Darryl cleared the panes by hand at 11:00.
#
# WHAT THIS IS NOT. It does NOT dismiss anything. Darryl owns the dismiss-sweeper; this is the
# deliberately safe half, shipped first because it carries almost no risk:
#   * it NEVER sends a keystroke, so it CANNOT select "Upgrade" (which spends the owner's money)
#   * it NEVER sends a keystroke, so it CANNOT clear a permission prompt (which would GRANT an
#     authorisation on his box with his credentials). A frozen agent is an inconvenience; an
#     auto-approved permission is unbounded. Freezing is the safe failure there.
# Detection without action is strictly safer than action, and it converts a 3.5-hour silent outage
# into a push within minutes. Toby's point: the alarm is FACE-AGNOSTIC — it fires on "the owner is
# not hearing from us" whether the cause is a modal, chunk-5 residue, a dirty pane, or a fourth
# face we have not met yet. That is why the alarm is the umbrella and goes first.
#
# ROLLBACK: systemctl --user disable --now frozen-pane-alarm.timer
set -uo pipefail

SOCKET=theoffice
ROOT="${OFFICE_TENANT_ROOT:-$(cd "$(dirname "$0")/../../tenant" && pwd)}"
DB="$ROOT/store/theoffice.db"
TOKEN_FILE="$ROOT/store/.dashboard-token"
STATE="$ROOT/store/frozen-pane-alarm.state"
LOG="$ROOT/store/frozen-pane-alarm.log"
COOLDOWN_S=1800          # re-alarm at most every 30 min per agent, so it cannot spam
AGE_ALARM_MIN=15         # owner message queued+undelivered this long = alarm regardless of cause

# Timestamps carry their UTC OFFSET (ISO 8601), not bare local time. 2026-08-04: this unit ran without
# TZ set, so timer-fired lines logged UTC while manual runs logged CEST — two clocks in one file, and the
# bare format made them indistinguishable. Setting TZ in the unit fixed the drift; this makes the log
# self-describing so a future copy of the unit WITHOUT TZ is still unambiguous, and so it correlates
# cleanly with Darryl's modal-sweeper log, which already stamps +00:00.
log() { printf '%s %s\n' "$(date '+%FT%T%:z')" "$1" >> "$LOG"; }

notify() {  # $1 = dedupe key, $2 = reason, $3 = OPTIONAL tmux session for the inspect hint.
            # Bus push; the dashboard relays. Never touches the pane.
  local now last key
  key="$1"
  now=$(date +%s)
  last=$(grep -E "^${key} " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$COOLDOWN_S" ]; then return 0; fi
  printf '%s %s\n' "$key" "$now" >> "$STATE"
  curl -s -X POST "http://127.0.0.1:3430/api/messages" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"from":"frozen-pane-alarm","to":"marveen","content":sys.argv[1]}))' \
        "FROZEN PANE / STUCK OWNER MESSAGE — $2. This alarm does NOT act, it only reports.${3:+ Inspect deliberately: tmux -L theoffice attach -t $3 .} If a pane is on a PERMISSION prompt, do NOT clear it blindly — read what is being asked first.")" >/dev/null 2>&1
  log "ALARM $key :: $2"
}

# --- log-only note, for a class that needs no human ----------------------------------------------
# the owner authorised this 2026-09-23 (relayed by marveen, bus 17735). MEASURED 2026-09-22: this script
# sent 62 alarms, 61 of them usage-limit. At ~3.9M cacheRead per recipient wake-up that is ~238M
# tokens -- about 6% of the fleet's entire 24h cacheRead -- spent telling agents that agents are
# rate-limited. Three reasons it had to stop being a message:
#   (a) its own text said "Transient and self-resolving; no owner action needed" -- a notification
#       that declares its own un-actionability;
#   (b) it was SELF-AMPLIFYING: it spent the exact resource whose exhaustion it was reporting, so it
#       got louder as the problem got worse;
#   (c) 11 of 33 pane alarms that day named marveen's OWN pane, and he is the only recipient -- he
#       cannot read them while he is the frozen one (card 84fb0a0f defect 1).
# The PERMISSION branch stays a message and stays able to page the owner: it is 1 of 62 and it is the
# only class that genuinely needs a human. Same cooldown/dedupe state as notify(), so the LOG gets one
# line per cooldown window rather than one every 2 minutes.
note() {  # $1 = dedupe key, $2 = reason.  Writes the log ONLY. Never the bus, never the pane.
  local now last key
  key="$1"
  now=$(date +%s)
  last=$(grep -E "^${key} " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$COOLDOWN_S" ]; then return 0; fi
  printf '%s %s\n' "$key" "$now" >> "$STATE"
  log "NOTE $key :: $2"
}

# --- owner-direct alarm, for the DANGEROUS class only -----------------------------------------
# 2026-08-04: a PERMISSION/approval gate freezes an agent until a HUMAN decides. Today cfo sat on a
# real "Dangerous rm on possibly-empty $WORK/*.pdf" gate for 2h40m and nobody knew, because the only
# alarm routed through marveen's bus queue — and that queue demonstrably backs up 45+ min when marveen
# is busy, and goes nowhere at all if marveen is the frozen one. An alarm that travels the same path
# as the thing it monitors is not an alarm.
# Darryl has since trimmed the modal-sweeper's permission alarm to log-only (correctly, to stop
# double-paging), which leaves THIS script as the only permission alarm until the engine watchdog
# ships with its owner-direct alarmOwner(). So this path must not depend on marveen being healthy.
# /api/outbound enqueues straight to the Slack sender: no pane, no agent session, no relay.
# ONLY the permission branch uses this. A late owner message does not warrant paging him directly;
# an agent frozen on an approval prompt does.
owner_alarm() {   # $1 = dedupe key, $2 = text
  local now last key
  key="owner-direct:$1"
  now=$(date +%s)
  last=$(grep -E "^${key} " "$STATE" 2>/dev/null | tail -1 | awk '{print $2}')
  if [ -n "${last:-}" ] && [ $((now - last)) -lt "$COOLDOWN_S" ]; then return 0; fi
  printf '%s %s\n' "$key" "$now" >> "$STATE"
  local uid
  uid=$(python3 -c "import json;print(json.load(open('$ROOT/config/overrides.json')).get('owner',{}).get('slackUserId',''))" 2>/dev/null)
  [ -z "$uid" ] && { log "owner_alarm SKIPPED: no owner slackUserId in config"; return 0; }
  curl -s -X POST "http://127.0.0.1:3430/api/outbound" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"agent":"marveen","channel":sys.argv[1],"text":sys.argv[2]}))' "$uid" "$2")" >/dev/null 2>&1
  log "OWNER-DIRECT $key"
}

# --- pane classifier — ONE definition, used by BOTH call sites --------------------------------
# 2026-09-16: there used to be two matchers in this file and they disagreed, and the OWNER-FACING one
# was the weaker. Section 1 had no busy check at all while pane_state() below did, so a pane that
# pane_state would have called "busy-long-turn" could still be escalated to the owner as a frozen approval
# prompt. Two copies of a rule drift, and the copy that drifts is never the harmless one.
#
# ORDER IS LOAD-BEARING, most specific first:
#   busy          -> the agent is WORKING. Never an alarm, never an escalation.
#   usage-limit   -> real, transient, self-resolving, needs no human. Marveen only, NEVER the owner.
#   permission    -> a genuine approval gate. The ONLY class allowed to page the owner.
#   unknown-modal -> a modal we cannot name. Marveen only, and the text says exactly that.
#   idle          -> nothing.
classify_pane() {   # $1 = pane text -> busy | usage-limit | permission | unknown-modal | idle
  case "$1" in
    *"esc to interrupt"*|*"Thinking"*|*"Compacting"*|*"tokens"*) echo "busy"; return ;;
  esac
  # USAGE LIMIT (the orchestrator's fix 3). The old patterns were "session limit" and "hit your ... limit" only,
  # so the wording actually shown on 2026-09-16 fell through to the generic-modal branch and was
  # labelled a possible permission prompt -- the one branch that pages the owner. Checked BEFORE the
  # generic modal on purpose: the upgrade selector carries "Enter to confirm" like every other selector.
  case "$1" in
    *"session limit"*|*"hit your"*"limit"*|*"usage limit"*|*"Usage limit"*|*"limit reached"*|*"limit will reset"*|*"resets at"*|*"Upgrade to Max"*|*"upgrade to continue"*)
      echo "usage-limit"; return ;;
  esac
  # A REAL permission gate NAMES AN ACTION AND ASKS FOR IT. "Enter to confirm" alone is not that: it is
  # the footer of every selector Claude Code draws, which is precisely how a usage-limit modal came to
  # be reported as a possible PERMISSION prompt. Match the question, not the footer.
  case "$1" in
    *"Do you want to"*|*"Do you trust"*|*"Allow this"*|*"wants permission"*|*"Dangerous"*|*"requires approval"*)
      echo "permission"; return ;;
  esac
  case "$1" in
    *"Enter to confirm"*|*"esc to cancel"*|*"Esc to cancel"*) echo "unknown-modal"; return ;;
  esac
  echo "idle"
}

# --- persistence gate for the OWNER path ------------------------------------------------------
# the orchestrator's fix 2: a false alarm to marveen costs ten minutes; a false alarm to the owner costs trust in
# every future alarm. So the owner path needs a higher bar than the agent path, and the cheapest higher
# bar is TIME -- the state has to still be there N checks later. An approval gate does not clear itself,
# so persistence costs a REAL alarm about four minutes and costs a transient one everything.
PERSIST_N=3              # consecutive observations required before the owner is paged
PERSIST_WINDOW_S=420     # a gap longer than this breaks the streak -> start again
persisted() {   # $1 = key -> true once the same state has been seen PERSIST_N times running
  local now n t line
  now=$(date +%s)
  line=$(grep -E "^persist:$1 " "$STATE" 2>/dev/null | tail -1)
  n=$(echo "$line" | awk '{print $2}'); t=$(echo "$line" | awk '{print $3}')
  if [ -n "${t:-}" ] && [ $((now - t)) -le "$PERSIST_WINDOW_S" ]; then n=$((n + 1)); else n=1; fi
  printf 'persist:%s %s %s\n' "$1" "$n" "$now" >> "$STATE"
  [ "$n" -ge "$PERSIST_N" ]
}

# --- 1. panes parked on a modal (footer replaced -> delivery gated shut) ----------------------
for s in $(tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | grep '^agent-'); do
  pane=$(tmux -L "$SOCKET" capture-pane -p -t "$s" 2>/dev/null | tail -6)
  case "$(classify_pane "$pane")" in
    busy|idle) : ;;
    usage-limit)
      # LOG ONLY (the owner 2026-09-23). Was notify(); 61 of 62 messages this script sent on 09-22 were
      # this branch, and its own text says no action is needed. See note() above for the measurement.
      note "$s" "pane is parked on a USAGE-LIMIT modal, so inbound delivery is gated shut for this agent. Transient and self-resolving; no owner action needed" ;;
    permission)
      notify "$s" "pane is parked on a PERMISSION prompt. NOT auto-clearing by design" "$s"
      if persisted "owner:$s"; then
        owner_alarm "$s" "An agent (${s#agent-}) is FROZEN on an approval prompt and cannot continue until a human answers it. Nothing has been touched — clearing it automatically could approve a delete, a payment or a deploy. It needs someone to read the actual question. the orchestrator has been told too, but this is sent to you directly in case he cannot reach you."
      else
        log "OWNER-HELD $s :: permission seen, awaiting persistence"
      fi ;;
    unknown-modal)
      # the orchestrator's fix 1. An unrecognised state is exactly when this has the LEAST standing to name a
      # cause, and it used to name the most alarming one available. It now reports what it knows, and
      # it does not page the owner on a guess.
      notify "$s" "pane state UNRECOGNISED, cause not determined — a modal is up but it matches no known pattern. Inspect before concluding anything; do NOT assume a permission prompt" "$s" ;;
  esac
done

# --- 2. owner messages queued too long, whatever the cause ------------------------------------
# This is the face-agnostic backstop: it fires even if the modal detector above misses entirely.
# Toby refinement: carry the agent's CURRENT pane-state so the alarm is self-diagnosing.
# A busy pane at 15 min is probably a long legitimate turn — lower urgency, but he has still
# waited, so still surface it. An unknown/modal/dirty pane at 15 min IS the bug — high urgency.
pane_state() {  # $1 = agent_id -> delegates to classify_pane, so the two can never disagree again
  local sess="agent-$1" txt
  txt=$(tmux -L "$SOCKET" capture-pane -p -t "$sess" 2>/dev/null | tail -6) || { echo "no-session"; return; }
  [ -z "$txt" ] && { echo "no-session"; return; }
  classify_pane "$txt"
}

# 2026-08-04: covers 'delivering' as well as 'queued'. A row is set to 'delivering' BEFORE the pane
# write; if the runtime dies mid-injection it stays there, and reapStaleDelivering() runs ONLY at boot
# (src/index.ts:30) — so while the process stays up, a stranded 'delivering' owner message is invisible
# to the boot reaper, to listOwnerAlarmable (which covers failed+queued), and to this alarm as written.
# Proven reachable: row 10518 sat in 'delivering' for 70+ min today. It was a bus row, so no owner harm
# that time. THIRD STATE, same silence.
stuck=$(sqlite3 "$DB" "select agent_id||':'||id||':'||cast((strftime('%s','now')-created_at)/60 as int)
  from inbound_queue
  where status in ('queued','delivering') and source='channel'
    and created_at < strftime('%s','now','-${AGE_ALARM_MIN} minutes');" 2>/dev/null)
if [ -n "$stuck" ]; then
  detail=""
  while IFS=: read -r ag rowid mins; do
    [ -z "$ag" ] && continue
    detail="${detail}${ag} msg ${rowid} waiting ${mins}min, pane=$(pane_state "$ag"); "
  done <<< "$stuck"
  notify "owner-queue" "an OWNER message has been queued and undelivered for over ${AGE_ALARM_MIN} min :: ${detail}"
fi

exit 0

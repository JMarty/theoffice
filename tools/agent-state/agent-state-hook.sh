#!/bin/sh
# agent-state hook (TRIAL, observe-only): appends "<ms>\t<event>\t<extra>" to $AGENT_STATE_DIR/<agent>.events.log for the agents named in
# AGENT_STATE_AGENTS (default: darryl). It never denies, rewrites or delays anything: prints nothing, always exits 0. Tool INPUT and notification
# TEXT are never recorded (only the event name, the tool name, and a notification class: perm | idle | other).
# Pause: touch $AGENT_STATE_DIR/DISABLE (all) or DISABLE-<agent>. Runs on every Claude Code lifecycle event, so it is plain sh (~2 ms).
D="${AGENT_STATE_DIR:-}"; A="${OFFICE_AGENT_ID:-}"
[ -n "$A" ] && [ -n "$D" ] || exit 0
case ",${AGENT_STATE_AGENTS:-darryl}," in *",$A,"*) ;; *) exit 0 ;; esac
[ -e "$D/DISABLE" ] && exit 0
[ -e "$D/DISABLE-$A" ] && exit 0
IN=$(dd bs=4096 count=1 2>/dev/null); cat >/dev/null 2>&1      # the event name and tool name are in the first 4 KB; drain the rest so the sender never sees a closed pipe
EV=$(printf '%s' "$IN" | sed -n 's/.*"hook_event_name" *: *"\([A-Za-z]*\)".*/\1/p' | head -1)
[ -n "$EV" ] || exit 0
X=""
case "$EV" in
  PreToolUse|PostToolUse) X=$(printf '%s' "$IN" | sed -n 's/.*"tool_name" *: *"\([A-Za-z0-9_]*\)".*/\1/p' | head -1) ;;
  Notification) case "$IN" in *ermission*) X=perm ;; *"waiting for your input"*) X=idle ;; *) X=other ;; esac ;;
esac
mkdir -p "$D" 2>/dev/null
F="$D/$A.events.log"
printf '%s\t%s\t%s\n' "$(date +%s%3N)" "$EV" "$X" >> "$F" 2>/dev/null
if [ "$EV" = Stop ] && [ "$(wc -c < "$F" 2>/dev/null || echo 0)" -gt 2000000 ]; then mv "$F" "$F.1" 2>/dev/null; fi   # bounded: one rotation kept
exit 0

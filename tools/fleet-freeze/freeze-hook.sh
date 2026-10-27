#!/bin/sh
# Fleet-freeze PreToolUse hook. Usage (from settings.json): sh freeze-hook.sh <path to store/fleet-freeze.json>
# While that file exists (readable or not) every tool call is rejected (exit 2, stderr goes back to the agent), EXCEPT a plain office-say (freeze_allow.py): a frozen agent can still tell the owner.
# Not frozen: no engine, no python, ~2 ms.
F="$1"
[ -n "$F" ] || exit 0
if [ -e "$F" ]; then
  # a frozen agent may still SPEAK to the owner: a plain office-say passes (freeze_allow.py decides, strictly); every other tool call is denied
  IN=$(cat)
  printf '%s' "$IN" | python3 "$(dirname "$0")/freeze_allow.py" 2>/dev/null && exit 0
  echo "FLEET FROZEN: the owner (or the system) has stopped all agent work. Do not run tools, do not look for another way around this and do not try to remove the freeze. Wait; the owner thaws it." >&2
  exit 2
fi
exit 0

#!/bin/sh
# Fleet-freeze PreToolUse hook. Usage (from settings.json): sh freeze-hook.sh <path to store/fleet-freeze.json>
# While that file exists (readable or not) EVERY tool call is rejected (exit 2, stderr goes back to the agent). No engine, no python: ~2 ms.
F="$1"
[ -n "$F" ] || exit 0
if [ -e "$F" ]; then
  echo "FLEET FROZEN: the owner (or the system) has stopped all agent work. Do not run tools, do not look for another way around this and do not try to remove the freeze. Wait; the owner thaws it." >&2
  exit 2
fi
exit 0

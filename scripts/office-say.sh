#!/usr/bin/env bash
# office-say — how an agent sends a Slack message to the owner.
#
# An agent (running inside its `claude` tmux session) calls:
#     office-say "your reply text"
# and it is posted to Slack AS that agent (its own name + avatar), to whoever last
# messaged it. The engine sets OFFICE_AGENT_ID / OFFICE_TENANT_ROOT / OFFICE_PORT
# in the session env; the reply channel is read from the agent's .reply-context
# (written by the deliverer) or OFFICE_REPLY_CHANNEL.
set -euo pipefail

MSG="${1:?usage: office-say \"message\"}"
AGENT="${OFFICE_AGENT_ID:?OFFICE_AGENT_ID not set (run inside an agent session)}"
TENANT="${OFFICE_TENANT_ROOT:?OFFICE_TENANT_ROOT not set}"
PORT="${OFFICE_PORT:-3430}"
TOKEN="$(cat "$TENANT/store/.dashboard-token")"
CHAN="${OFFICE_REPLY_CHANNEL:-$(cat "$TENANT/agents/$AGENT/.reply-context" 2>/dev/null || true)}"
[ -n "$CHAN" ] || { echo "office-say: no reply channel known (no one has messaged $AGENT yet?)" >&2; exit 1; }

python3 - "$AGENT" "$CHAN" "$MSG" "$TOKEN" "$PORT" <<'PY'
import sys, json, urllib.request
agent, chan, msg, token, port = sys.argv[1:6]
data = json.dumps({"agent": agent, "channel": chan, "text": msg}).encode()
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/outbound",
    data=data,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
urllib.request.urlopen(req, timeout=10).read()
print("sent")
PY

#!/usr/bin/env bash
# Create + launch a new agent from the product template. Non-interactive, so the
# main agent (or a human) can call it once the Slack tokens are in hand.
# Usage: new-agent.sh <id> <displayName> <role> <xapp-token> <xoxb-token>
set -euo pipefail

ID="${1:?usage: new-agent <id> <displayName> <role> <appToken> <botToken>}"
NAME="${2:?displayName required}"
ROLE="${3:?role required}"
APP="${4:?app-level token (xapp-...) required}"
BOT="${5:?bot token (xoxb-...) required}"

ID="$(printf '%s' "$ID" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-')"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
PORT="$(node -e "try{process.stdout.write(String(require('$TENANT/config/overrides.json').web.port||3430))}catch{process.stdout.write('3430')}" 2>/dev/null || echo 3430)"
SOCKET="$(node -e "try{process.stdout.write(String(require('$TENANT/config/overrides.json').tmux.socket||'theoffice'))}catch{process.stdout.write('theoffice')}" 2>/dev/null || echo theoffice)"

dst="$TENANT/agents/$ID"
if [ -e "$dst/CLAUDE.md" ]; then echo "agent '$ID' already exists at $dst" >&2; exit 1; fi
mkdir -p "$dst" "$TENANT/secrets/slack"

# persona from the product template
sed -e "s/@@NAME@@/$NAME/g" -e "s/@@ID@@/$ID/g" -e "s|@@ROLE@@|$ROLE|g" -e "s/@@PORT@@/$PORT/g" \
  "$INSTALL_DIR/templates/product/agent.CLAUDE.md" > "$dst/CLAUDE.md"
printf '{ "displayName": "%s", "enabled": true }\n' "$NAME" > "$dst/agent.json"

# slack identity
cat > "$TENANT/secrets/slack/$ID.json" <<EOF
{ "appToken": "$APP", "botToken": "$BOT", "botUserId": "" }
EOF
chmod 600 "$TENANT/secrets/slack/$ID.json"

# validate token + capture bot user id (never prints token)
python3 - "$TENANT/secrets/slack/$ID.json" <<'PY'
import json, sys, urllib.request
p = sys.argv[1]; c = json.load(open(p))
r = json.load(urllib.request.urlopen(urllib.request.Request(
    "https://slack.com/api/auth.test", data=b"", headers={"Authorization": "Bearer " + c["botToken"]}), timeout=15))
if not r.get("ok"):
    sys.exit("Slack token invalid: " + str(r.get("error")))
c["botUserId"] = r["user_id"]; json.dump(c, open(p, "w"), indent=2)
print("Slack OK - bot " + str(r.get("user")) + " (" + str(r.get("user_id")) + ")")
PY

# restart engine so the new ingest socket opens (does NOT kill agent tmux sessions — separate server),
# then launch this agent's pure claude session
systemctl --user restart theoffice.service 2>/dev/null || true
sleep 3
node "$INSTALL_DIR/scripts/launch-agent.mjs" "$ID" || true
echo "Agent '$ID' ($NAME) created and launched. Have the owner DM @$NAME in Slack."

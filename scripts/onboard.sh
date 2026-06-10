#!/usr/bin/env bash
# The Office — first-run onboarding wizard. Creates the MAIN agent, wires its
# Slack identity, captures the owner, starts everything, and hands over to the
# agent as a concierge. Run once, after install.sh. Idempotent-ish (safe to re-run;
# it will offer to reuse an existing main agent).
set -euo pipefail

[ "$(id -u)" -eq 0 ] && { echo "Run as your normal user, not root." >&2; exit 1; }

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
DB="$TENANT/store/theoffice.db"
PORT="$(node -e "try{process.stdout.write(String(require('$TENANT/config/overrides.json').web.port||3430))}catch{process.stdout.write('3430')}" 2>/dev/null || echo 3430)"
TZv="$(cat /etc/timezone 2>/dev/null || (command -v timedatectl >/dev/null && timedatectl show -p Timezone --value) || echo UTC)"
IP="$(ip -4 addr 2>/dev/null | grep -oE 'inet [0-9.]+' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')"
IP="${IP:-127.0.0.1}"
DASH="http://$IP:$PORT"

c(){ printf '\033[1;36m%s\033[0m\n' "$*"; }
b(){ printf '\033[1m%s\033[0m\n' "$*"; }
# read from the controlling terminal so the wizard works even under `curl | bash`
ask(){ printf '\033[1;33m%s\033[0m ' "$1"; read -r REPLY </dev/tty; }
pause(){ printf '\033[2m%s\033[0m ' "${1:-Press Enter to continue...}"; read -r _ </dev/tty; }

clear || true
b "================  Welcome to The Office  ================"
echo "Let's set up your back office. I'll create your main agent, connect it to Slack,"
echo "and bring it online. Takes about 5 minutes; I'll guide each step."
echo

# ---- Step 1: Claude account -------------------------------------------------
c "Step 1 / 5 — Connect your Claude account"
if [ -f "$HOME/.claude/.credentials.json" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "  ✓ Claude Code is already logged in."
else
  echo "  Your agents think using Claude, so Claude Code needs to be logged in."
  echo "  In ANOTHER terminal run:  claude login    (or, headless: 'claude setup-token' on a"
  echo "  machine with a browser, then: export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...)"
  pause "Press Enter once Claude is logged in..."
fi
echo

# ---- Step 2: main agent -----------------------------------------------------
c "Step 2 / 5 — Create your main agent"
ask "What's your main agent's name? (e.g. Atlas, Friday, Jarvis):"; NAME="${REPLY:-Atlas}"
ID="$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"; [ -z "$ID" ] && ID="main"
ask "One-line role for $NAME? (e.g. my chief of staff):"; ROLE="${REPLY:-your chief of staff}"
mkdir -p "$TENANT/agents/$ID" "$TENANT/secrets/slack" "$TENANT/config"
sed -e "s/@@NAME@@/$NAME/g" -e "s/@@ID@@/$ID/g" -e "s|@@ROLE@@|$ROLE|g" -e "s/@@PORT@@/$PORT/g" \
  "$INSTALL_DIR/templates/product/agent.CLAUDE.md" > "$TENANT/agents/$ID/CLAUDE.md"
sed "s|@@DASHBOARD_URL@@|$DASH|g" "$INSTALL_DIR/templates/product/concierge.md" >> "$TENANT/agents/$ID/CLAUDE.md"
printf '{ "displayName": "%s", "enabled": true }\n' "$NAME" > "$TENANT/agents/$ID/agent.json"
python3 - "$TENANT/config/overrides.json" "$ID" "$TZv" <<'PY'
import json,sys,os
p,mid,tz=sys.argv[1],sys.argv[2],sys.argv[3]
c=json.load(open(p)) if os.path.exists(p) else {}
c["mainAgentId"]=mid
c.setdefault("owner",{}); c["owner"].setdefault("slackUserId",""); c["owner"]["timezone"]=tz; c["owner"].setdefault("displayName","Owner")
c["channel"]={"provider":"slack"}
json.dump(c,open(p,"w"),indent=2)
PY
echo "  ✓ Created $NAME ($ID)."
echo

# ---- Step 3: Slack ----------------------------------------------------------
c "Step 3 / 5 — Give $NAME a Slack identity"
echo "  1) If you don't have a Slack workspace, make a free one at slack.com/create"
echo "  2) Go to  https://api.slack.com/apps  → Create New App → From an app manifest → pick your workspace"
echo "  3) Delete the box content, choose the JSON tab, paste THIS (then Next → Create):"
echo
cat <<EOF
{
  "display_information": { "name": "$NAME", "description": "back office colleague" },
  "features": {
    "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "$NAME", "always_online": true }
  },
  "oauth_config": { "scopes": { "bot": ["chat:write","im:history","im:read","im:write","users:read"] } },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.im"] },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false, "socket_mode_enabled": true, "token_rotation_enabled": false
  }
}
EOF
echo
echo "  4) Basic Information → App-Level Tokens → Generate Token and Scopes → add 'connections:write' → Generate → copy the xapp-… token"
echo "  5) OAuth & Permissions → Install to Workspace → Allow → copy the 'Bot User OAuth Token' (xoxb-…)"
echo
ask "Paste the App-Level token (xapp-...):"; APP="$REPLY"
ask "Paste the Bot User OAuth token (xoxb-...):"; BOT="$REPLY"
cat > "$TENANT/secrets/slack/$ID.json" <<EOF
{ "appToken": "$APP", "botToken": "$BOT", "botUserId": "" }
EOF
chmod 600 "$TENANT/secrets/slack/$ID.json"
python3 - "$TENANT/secrets/slack/$ID.json" <<'PY'
import json,sys,urllib.request
p=sys.argv[1]; c=json.load(open(p))
r=json.load(urllib.request.urlopen(urllib.request.Request("https://slack.com/api/auth.test",data=b"",headers={"Authorization":"Bearer "+c["botToken"]}),timeout=15))
if not r.get("ok"): sys.exit("  ✗ Slack token invalid: "+str(r.get("error"))+" — re-run onboard.sh")
c["botUserId"]=r["user_id"]; json.dump(c,open(p,"w"),indent=2)
print("  ✓ Slack connected — bot "+str(r.get("user")))
PY
echo

# ---- Step 4: start + capture owner -----------------------------------------
c "Step 4 / 5 — Bring $NAME online"
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
systemctl --user restart theoffice.service >/dev/null 2>&1 || systemctl --user start theoffice.service >/dev/null 2>&1 || true
sleep 3
node "$INSTALL_DIR/scripts/launch-agent.mjs" "$ID" >/dev/null 2>&1 || true
sleep 2
b "  Now open Slack, find $NAME (under Apps), and send any message (e.g. 'hi')."
echo "  I'll capture your Slack id so $NAME only answers YOU. Waiting (up to 3 min)..."
OWNER=""
for i in $(seq 1 90); do
  OWNER="$(sqlite3 "$DB" "SELECT reply_user FROM inbound_queue WHERE agent_id='$ID' AND source='channel' AND reply_user IS NOT NULL ORDER BY id DESC LIMIT 1;" 2>/dev/null || true)"
  [ -n "$OWNER" ] && break
  sleep 2
done
if [ -n "$OWNER" ]; then
  python3 - "$TENANT/config/overrides.json" "$OWNER" <<'PY'
import json,sys; p=sys.argv[1]; c=json.load(open(p)); c.setdefault("owner",{})["slackUserId"]=sys.argv[2]; json.dump(c,open(p,"w"),indent=2)
PY
  systemctl --user restart theoffice.service >/dev/null 2>&1 || true
  echo "  ✓ Owner captured ($OWNER) — $NAME is now locked to you."
else
  echo "  (Didn't catch a message yet — that's fine. $NAME will still answer; set owner later in the dashboard.)"
fi
echo

# ---- Step 5: done -----------------------------------------------------------
c "Step 5 / 5 — You're live 🎉"
TOKEN="$(cat "$TENANT/store/.dashboard-token" 2>/dev/null || echo '<see store/.dashboard-token>')"
b "  Dashboard:  $DASH"
echo "  API token:  $TOKEN   (paste once in the dashboard login box)"
echo "  Logs:       journalctl --user -u theoffice.service -f"
echo
echo "  Next: DM $NAME in Slack again — they'll introduce themselves, show you around,"
echo "  and offer to build out your team (finance, home, travel… whatever you need)."
echo
b "Welcome to The Office."

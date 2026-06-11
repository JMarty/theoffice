#!/usr/bin/env bash
# The Office — one-shot installer for a fresh Linux container (Debian/Ubuntu).
#
# Run as your normal user (NEVER root/sudo — see the guard below). It:
#   1. checks prerequisites (node 20-22, tmux, sqlite3, git, claude CLI)
#   2. installs npm deps + builds (tsc -> dist/)
#   3. lays down the tenant skeleton
#   4. installs systemd --user units:
#        - theoffice-tmux.service : owns a DEDICATED tmux server (-L theoffice)
#          in its OWN cgroup, so restarting the engine can never kill the fleet
#        - theoffice.service      : the engine (dashboard + ingest + scheduler + bus),
#          which After/Wants the tmux unit
#   5. enables linger, starts everything, prints the dashboard URL + token
#
# Re-runnable (idempotent). Usage:
#   bash scripts/install.sh
set -euo pipefail

# ---- 0. never root ----------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: do not run this installer as root/sudo." >&2
  echo "Run it as your normal user. systemd --user units under root crash-loop and" >&2
  echo "'claude --dangerously-skip-permissions' refuses to run as root." >&2
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT_ROOT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
TZ_VALUE="${OFFICE_TZ:-Europe/Budapest}"
SOCKET="${OFFICE_TMUX_SOCKET:-theoffice}"
UNIT_DIR="$HOME/.config/systemd/user"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# ---- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"
need() { command -v "$1" >/dev/null 2>&1 || { warn "missing: $1 ($2)"; MISSING=1; }; }
MISSING=0
need node "install Node.js 20-22"
need npm "comes with Node.js"
need tmux "apt install tmux"
need sqlite3 "apt install sqlite3"
need git "apt install git"
if ! command -v claude >/dev/null 2>&1; then
  warn "claude CLI not found — agents cannot run without it. Install Claude Code and 'claude login' (or set CLAUDE_CODE_OAUTH_TOKEN) before starting agents."
fi
[ "${MISSING:-0}" = "1" ] && { warn "install the missing tools above, then re-run."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -gt 22 ]; then
  warn "Node $NODE_MAJOR detected; recommended 20-22 (better-sqlite3 prebuilds)."
fi

# ---- 2. build ---------------------------------------------------------------
say "Installing dependencies ($INSTALL_DIR)"
cd "$INSTALL_DIR"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
say "Building (tsc -> dist/)"
npm run build

say "Installing the office-say reply helper -> ~/.local/bin/office-say"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$INSTALL_DIR/scripts/office-say.sh" "$HOME/.local/bin/office-say"

# ---- 3. tenant skeleton -----------------------------------------------------
say "Preparing tenant root: $TENANT_ROOT"
mkdir -p "$TENANT_ROOT"/{store,agents,secrets/slack,scheduled-tasks,skills,config}
chmod 700 "$TENANT_ROOT/secrets"
if [ ! -f "$TENANT_ROOT/config/overrides.json" ]; then
  if [ -f "$INSTALL_DIR/tenant/config/overrides.example.json" ]; then
    cp "$INSTALL_DIR/tenant/config/overrides.example.json" "$TENANT_ROOT/config/overrides.json"
    say "seeded tenant/config/overrides.json from example — EDIT it (owner, channel, slackUserId)"
  fi
fi

# ---- 4. systemd --user units ------------------------------------------------
say "Installing systemd --user units"
mkdir -p "$UNIT_DIR"
NODE_BIN="$(command -v node)"
TMUX_BIN="$(command -v tmux)"

cat > "$UNIT_DIR/theoffice-tmux.service" <<EOF
[Unit]
Description=The Office — dedicated tmux server (isolated fleet, own cgroup)

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$TMUX_BIN -L $SOCKET new-session -d -s __keepalive sleep 86400
ExecStop=$TMUX_BIN -L $SOCKET kill-server
Environment=TZ=$TZ_VALUE

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/theoffice.service" <<EOF
[Unit]
Description=The Office — engine (dashboard + slack ingest + scheduler + bus)
After=theoffice-tmux.service
Wants=theoffice-tmux.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=TZ=$TZ_VALUE
Environment=OFFICE_TENANT_ROOT=$TENANT_ROOT
Environment=OFFICE_TMUX_SOCKET=$SOCKET

[Install]
WantedBy=default.target
EOF

# ---- 5. enable + start ------------------------------------------------------
# Linger lets the user's systemd instance (user@<uid>.service) start at boot
# WITHOUT an interactive login — otherwise the fleet only comes up when someone
# logs in. enable-linger is privileged (polkit/root), so the plain call silently
# fails under `curl | bash` (no tty). Try sudo first, then verify, then shout.
say "Enabling linger (so the fleet starts at boot, without login)"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  say "linger already enabled"
else
  # enable-linger needs root/polkit; try passwordless sudo, then interactive, then plain.
  if sudo -n loginctl enable-linger "$USER" 2>/dev/null \
     || sudo loginctl enable-linger "$USER" 2>/dev/null \
     || loginctl enable-linger "$USER" 2>/dev/null; then :; fi
fi
# verify — do NOT continue silently if it failed
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  warn "LINGER IS STILL OFF. The fleet will NOT start at boot until you run:"
  warn "    sudo loginctl enable-linger $USER"
  warn "Verify with: loginctl show-user $USER | grep Linger   # want: Linger=yes"
fi

say "Starting services"
systemctl --user daemon-reload
systemctl --user enable --now theoffice-tmux.service
systemctl --user enable --now theoffice.service

sleep 2
PORT="$(node -e "try{const c=require('$TENANT_ROOT/config/overrides.json');process.stdout.write(String((c.web&&c.web.port)||3430))}catch{process.stdout.write('3430')}")"
TOKEN_FILE="$TENANT_ROOT/store/.dashboard-token"
say "The Office is up."
echo "  Dashboard : http://127.0.0.1:$PORT"
[ -f "$TOKEN_FILE" ] && echo "  API token : $(cat "$TOKEN_FILE")"
echo "  Logs      : journalctl --user -u theoffice.service -f"
echo "  Next      : edit $TENANT_ROOT/config/overrides.json, add agents under tenant/agents/<id>/,"
echo "              and per-agent Slack tokens under tenant/secrets/slack/<id>.json (see docs/CHANNELS-SETUP.md)."

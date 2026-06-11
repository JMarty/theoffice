#!/usr/bin/env bash
# The Office — one-paste installer for a fresh Debian/Ubuntu home server.
#   curl -fsSL https://raw.githubusercontent.com/szoszo/theoffice/main/bootstrap.sh | bash
# Installs all dependencies, the engine (NO agents/memories — a clean tenant),
# then launches the guided onboarding wizard. Run as your normal user (it sudo's
# only for apt). Nothing of the author's data is included.
#
# Dashboard binds to localhost by default (safe). To expose it on your LAN
# (reach it from your phone/laptop), run:
#   curl -fsSL .../bootstrap.sh | OFFICE_BIND=lan bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] && { echo "Run as your normal user (it will sudo for apt), NOT as root." >&2; exit 1; }

REPO="${OFFICE_REPO:-https://github.com/szoszo/theoffice.git}"
DIR="${OFFICE_DIR:-$HOME/theoffice}"
say(){ printf '\033[1;34m==>\033[0m %s\n' "$*"; }

say "Installing system packages (you'll be asked for sudo)"
sudo apt-get update -y
sudo apt-get install -y git tmux sqlite3 curl ca-certificates python3 build-essential rsync

# Node.js 20-22 (better-sqlite3 prebuilds)
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  MJ="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$MJ" -ge 20 ] && [ "$MJ" -le 22 ] && NODE_OK=1
fi
if [ "$NODE_OK" != 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Claude Code CLI (the agents' brain)
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code CLI"
  sudo npm install -g @anthropic-ai/claude-code 2>/dev/null || npm install -g @anthropic-ai/claude-code || \
    say "Could not auto-install Claude Code — install it manually, then 'claude login'."
fi

say "Fetching The Office -> $DIR"
if [ -d "$DIR/.git" ]; then (cd "$DIR" && git pull --ff-only || true); else git clone "$REPO" "$DIR"; fi
cd "$DIR"

say "Installing the engine (build + services; clean empty tenant)"
bash scripts/install.sh

say "Starting the setup wizard"
exec bash scripts/onboard.sh </dev/tty

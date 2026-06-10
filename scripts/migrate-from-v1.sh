#!/usr/bin/env bash
# The Office — migrate the existing v1 ("marveen") fleet onto this box as tenant #1.
#
# READ-ONLY on the source: it copies data forward and runs the verified importer.
# The old box stays the rollback floor. Run AFTER install.sh, as your normal user.
#
# Usage:
#   bash scripts/migrate-from-v1.sh \
#       --old-repo /opt/claude/marveen/marveen \
#       --old-home "$HOME/.claude"
set -euo pipefail

OLD_REPO="/opt/claude/marveen/marveen"
OLD_HOME="$HOME/.claude"
while [ $# -gt 0 ]; do
  case "$1" in
    --old-repo) OLD_REPO="$2"; shift 2;;
    --old-home) OLD_HOME="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT_ROOT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

[ -d "$OLD_REPO" ] || { warn "old repo not found: $OLD_REPO"; exit 1; }

# 1. DB (crown jewel) via the verified importer (safe hot snapshot, zero-loss)
say "Importing claudeclaw.db -> tenant store (verified zero-loss)"
OFFICE_TENANT_ROOT="$TENANT_ROOT" node "$INSTALL_DIR/dist/migrate-import/import-claudeclaw.js" --source "$OLD_REPO/store/claudeclaw.db" \
  || OFFICE_TENANT_ROOT="$TENANT_ROOT" npx tsx "$INSTALL_DIR/src/migrate-import/import-claudeclaw.ts" --source "$OLD_REPO/store/claudeclaw.db"

# 2. vault key (CRITICAL — without it vault secrets are unreadable)
if [ -f "$OLD_REPO/store/.vault-key" ]; then
  cp -n "$OLD_REPO/store/.vault-key" "$TENANT_ROOT/store/.vault-key" && chmod 600 "$TENANT_ROOT/store/.vault-key"
  say "copied .vault-key"
else
  warn "no .vault-key found at $OLD_REPO/store — vault secrets will be unreadable if you rely on them"
fi

# 3. agents -> tenant/agents/<id>/ : persona AND all working files (specs, docs,
#    finance/kifli data, tools). EXCLUDE old channel state, old .claude settings,
#    and HANDOFF.md (stale auto-read). Needs rsync.
say "Copying agent personas + working files"
mkdir -p "$TENANT_ROOT/agents"
for d in "$OLD_REPO"/agents/*/; do
  [ -d "$d" ] || continue
  id="$(basename "$d")"
  [ "$id" = "heartbeat" ] && continue
  [ "$id" = "heartbeat-worker" ] && continue
  dst="$TENANT_ROOT/agents/$id"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --ignore-existing --exclude='channels/' --exclude='.claude/' --exclude='HANDOFF.md' "$d" "$dst/" 2>/dev/null || true
  else
    cp -rn "$d"/* "$dst/" 2>/dev/null || true
    rm -rf "$dst/channels" "$dst/.claude" "$dst/HANDOFF.md" 2>/dev/null || true
  fi
  if [ ! -f "$dst/agent.json" ]; then
    printf '{ "displayName": "%s", "enabled": true }\n' "$id" > "$dst/agent.json"
  fi
done
say "sub-agent personas + working files copied (CLAUDE.md still references Telegram — see checklist)"

# the MAIN agent (e.g. Michael) lives at the v1 repo ROOT, not under agents/
MAIN_ID="${OFFICE_MAIN_AGENT:-marveen}"
if [ -f "$OLD_REPO/CLAUDE.md" ]; then
  mkdir -p "$TENANT_ROOT/agents/$MAIN_ID"
  cp -n "$OLD_REPO/CLAUDE.md" "$TENANT_ROOT/agents/$MAIN_ID/CLAUDE.md" 2>/dev/null || true
  [ -f "$OLD_REPO/SOUL.md" ] && cp -n "$OLD_REPO/SOUL.md" "$TENANT_ROOT/agents/$MAIN_ID/SOUL.md" 2>/dev/null || true
  [ -f "$TENANT_ROOT/agents/$MAIN_ID/agent.json" ] || printf '{ "displayName": "%s", "enabled": true }\n' "$MAIN_ID" > "$TENANT_ROOT/agents/$MAIN_ID/agent.json"
  say "copied MAIN agent persona from repo root -> agents/$MAIN_ID"
fi

# 4. scheduled tasks (PRESERVE enabled/disabled state — don't resurrect killed bugs)
if [ -d "$OLD_HOME/scheduled-tasks" ]; then
  say "Copying scheduled tasks (state preserved)"
  cp -rn "$OLD_HOME/scheduled-tasks/." "$TENANT_ROOT/scheduled-tasks/" 2>/dev/null || true
fi

# 5. skills (accumulated learning)
if [ -d "$OLD_HOME/skills" ]; then
  say "Copying skills"
  cp -rn "$OLD_HOME/skills/." "$TENANT_ROOT/skills/" 2>/dev/null || true
fi

# 6. non-Telegram secrets (gmail creds, service accounts). Telegram tokens are NOT
#    migrated — each agent gets a fresh Slack identity instead.
say "Copying non-channel secrets (gmail/service-accounts)"
for s in .gmail-creds .secrets; do
  [ -d "$OLD_REPO/$s" ] && cp -rn "$OLD_REPO/$s" "$TENANT_ROOT/secrets/$(basename "$s")" 2>/dev/null || true
done
chmod -R go-rwx "$TENANT_ROOT/secrets" 2>/dev/null || true

# 7. reference content folders -> owning agent dirs (archives, read on demand)
say "Copying reference content folders"
content_copy(){ [ -d "$OLD_REPO/$1" ] && { mkdir -p "$(dirname "$2")"; cp -rn "$OLD_REPO/$1" "$2" 2>/dev/null; say "  $1 -> $2"; }; }
content_copy "Pam"                "$TENANT_ROOT/agents/pam/Pam"
content_copy "budva-26-meetup"    "$TENANT_ROOT/agents/pam/budva-26-meetup"
content_copy "cookbook"           "$TENANT_ROOT/agents/dwight/cookbook"
content_copy "Dwight"             "$TENANT_ROOT/agents/dwight/Dwight"
content_copy "CFO"                "$TENANT_ROOT/agents/cfo/CFO"
content_copy "Jim"                "$TENANT_ROOT/agents/jim/Jim"
content_copy "photos botik"       "$TENANT_ROOT/agents/$MAIN_ID/photos-botik"
content_copy "Uploaded documents" "$TENANT_ROOT/agents/$MAIN_ID/Uploaded-documents"
content_copy "adatok"             "$TENANT_ROOT/agents/$MAIN_ID/adatok"
content_copy "agents-archived"    "$TENANT_ROOT/agents-archived"

cat <<'CHECK'

==> Copy-forward complete. MANUAL steps before cutover (see docs/CHANNELS-SETUP.md):
  [ ] Create one Slack app per agent; put tokens in tenant/secrets/slack/<id>.json
  [ ] Rewrite each agent's CLAUDE.md: remove Telegram/chat-id instructions; the
      channel is now external Slack (agents reply via /api/outbound, not a plugin)
  [ ] Set tenant/config/overrides.json: channel.provider=slack, owner.slackUserId
  [ ] Verify counts in the dashboard match the old box (memories/kanban/logs)
  [ ] Only after green: stop the OLD box. It stays as rollback until then.
CHECK

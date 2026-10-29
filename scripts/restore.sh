#!/usr/bin/env bash
# The Office: restore the PERSONAL half of the office from the encrypted nightly backup (the generic half comes from this repo via install.sh).
#
# Rebuild order on a fresh box:
#   1. git clone <this repo URL> && cd theoffice
#   2. bash scripts/install.sh                        (engine + methodology templates, clean tenant)
#   3. download the newest office-YYYYMMDD-HHMM.tar.gz.gpg from your backup folder on Drive (browser is fine)
#   4. bash scripts/restore.sh ~/Downloads/office-....tar.gz.gpg      (asks for the backup passphrase; never stored here)
#   5. systemctl --user daemon-reload && systemctl --user restart theoffice
# Full walk-through and the list of what is in the archive: RESTORE.md
#
# Options / env:
#   --dry-run              decrypt, verify the manifest, print what would be restored; touch nothing
#   --force                overwrite an existing tenant store (default: refuse when store/*.db already exist)
#   --no-repos             do not clone the own repos listed in repos.json
#   OFFICE_TENANT_ROOT     tenant root to restore into (default: <repo>/tenant)
#   RESTORE_HOME           home directory to restore ~/.claude/skills, user units and helper bin into (default: $HOME)
#   BACKUP_PASSPHRASE_FILE read the passphrase from this file instead of asking
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT_ROOT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
RHOME="${RESTORE_HOME:-$HOME}"
DRY=0; FORCE=0; REPOS=1; ARCHIVE=""
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --force) FORCE=1;; --no-repos) REPOS=0;; -h|--help) sed -n 2,20p "$0"; exit 0;; -*) echo "unknown option $a" >&2; exit 2;; *) ARCHIVE="$a";; esac; done
say(){ printf '==> %s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "usage: scripts/restore.sh [--dry-run] [--force] [--no-repos] <office-....tar.gz.gpg>"
command -v gpg >/dev/null || die "gpg is required (apt install gnupg)"
if [ "$DRY" = 0 ] && ls "$TENANT_ROOT"/store/*.db >/dev/null 2>&1 && [ "$FORCE" = 0 ]; then
  die "$TENANT_ROOT/store already holds databases. Stop the engine and re-run with --force, or restore into an empty tenant (OFFICE_TENANT_ROOT=...)."
fi
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/office-restore.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then PASSFD="$BACKUP_PASSPHRASE_FILE"; else
  read -rsp "Backup passphrase: " PW; echo; PASSFD="$WORK/.pw"; umask 077; printf '%s' "$PW" > "$PASSFD"; unset PW
fi
say "Decrypting"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFD" --decrypt -o "$WORK/a.tar.gz" "$ARCHIVE" 2>/dev/null || die "decrypt failed (wrong passphrase or damaged file)"
rm -f "$WORK/.pw"
say "Unpacking"; tar -xzf "$WORK/a.tar.gz" -C "$WORK"; rm -f "$WORK/a.tar.gz"
B="$WORK/office-backup"; [ -d "$B" ] || die "not an office backup (no office-backup/ inside)"
say "Verifying manifest"
( cd "$B" && grep -v '^[0-9a-f]\{64\}  MANIFEST.sha256$' MANIFEST.sha256 | sha256sum --quiet -c - ) || die "manifest check failed: archive is damaged"
n_tasks=$(ls "$B/scheduled-tasks" 2>/dev/null | wc -l); n_skills=$(ls "$B/skills" 2>/dev/null | wc -l); n_hskills=$(ls "$B/home/.claude/skills" 2>/dev/null | wc -l); n_agents=$(ls "$B/agents" 2>/dev/null | wc -l)
say "Archive holds: $n_tasks scheduled tasks, $n_skills tenant skills, $n_hskills user skills, $n_agents agents, $(ls "$B"/store/*.db 2>/dev/null | wc -l) store databases"
if [ "$DRY" = 1 ]; then say "dry run: nothing written"; exit 0; fi
mkdir -p "$TENANT_ROOT" "$RHOME/.claude" "$RHOME/.config/systemd/user" "$RHOME/.local/bin"
put(){ # put <src dir or file> <dst>
  [ -e "$1" ] || return 0; mkdir -p "$(dirname "$2")"; cp -a "$1" "$2"; }
say "Restoring tenant into $TENANT_ROOT"
for d in store scheduled-tasks skills tools config agents secrets; do
  [ -d "$B/$d" ] && { mkdir -p "$TENANT_ROOT/$d"; cp -a "$B/$d/." "$TENANT_ROOT/$d/"; }
done
for f in "$B"/*.md; do [ -f "$f" ] && cp -a "$f" "$TENANT_ROOT/"; done
chmod 700 "$TENANT_ROOT/secrets" 2>/dev/null || true
say "Restoring user layer into $RHOME"
[ -d "$B/home/.claude/skills" ] && { mkdir -p "$RHOME/.claude/skills"; cp -a "$B/home/.claude/skills/." "$RHOME/.claude/skills/"; }
[ -d "$B/home/.config/systemd/user" ] && { mkdir -p "$RHOME/.config/systemd/user"; cp -a "$B/home/.config/systemd/user/." "$RHOME/.config/systemd/user/"; }
for f in "$B"/home/.local/bin/*; do [ -f "$f" ] && { cp -a "$f" "$RHOME/.local/bin/"; chmod +x "$RHOME/.local/bin/$(basename "$f")"; }; done
for m in "$B"/claude-projects/*/memory; do [ -d "$m" ] || continue; p="$RHOME/.claude/projects/$(basename "$(dirname "$m")")/memory"; mkdir -p "$p"; cp -a "$m/." "$p/"; done
if [ "$REPOS" = 1 ] && [ -f "$B/repos.json" ]; then
  PAT_FILE="$TENANT_ROOT/secrets/github/theoffice.pat"
  say "Cloning own repos listed in repos.json (missing ones only)"
  python3 - "$B/repos.json" "$INSTALL_DIR" "$PAT_FILE" <<'PY'
import base64, json, os, subprocess, sys
repos, root, patf = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
hdr = []
if os.path.exists(patf):
    pat = open(patf).read().strip(); hdr = ["-c", "http.extraheader=Authorization: Basic " + base64.b64encode(f"x-access-token:{pat}".encode()).decode()]
for rel, url in sorted(repos.items()):
    dst = os.path.normpath(os.path.join(root, rel))
    if rel == "." or os.path.isdir(os.path.join(dst, ".git")): continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(["git"] + hdr + ["clone", "-q", url, dst], capture_output=True, text=True)
    print(("cloned " if r.returncode == 0 else "FAILED ") + rel + ("" if r.returncode == 0 else ": " + r.stderr.strip()[-100:]))
PY
fi
for d in app-data; do [ -d "$B/$d" ] && say "App data is in the archive ($d/): copy it into the app repo's data/ after the repo is cloned"; done
for d in db-export; do [ -d "$B/$d" ] && say "A database dump is in the archive ($d/): re-import it (wrangler d1 execute) only if the database itself was lost"; done
say "Done. Next: systemctl --user daemon-reload && systemctl --user restart theoffice   (then check the dashboard)"

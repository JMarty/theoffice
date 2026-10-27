# Rebuild the office from scratch

Two halves, one path back.

| Half | Lives in | Contains |
|---|---|---|
| Generic (the methodology) | this repo, `templates/` | skills, background tasks, agent personas, fleet rules, tools (exported nightly from the running office, anonymised) |
| Personal (everything else) | the encrypted nightly backup on Google Drive, your backup folder on Google Drive | memories and message history (store DBs), personal scheduled tasks and skills, agent files and memory, secrets, config, user systemd units, `office-say`, the list of own repos, app data and any database dumps |

Own code repos (apps, tools) are separate GitHub repos; the backup carries their list (`repos.json`) and the token needed to clone them.

## Steps on a fresh Linux box (Debian/Ubuntu, normal user, not root)

1. `git clone <this repo's URL> && cd theoffice`
2. `bash scripts/install.sh` : engine, build, services, empty tenant, and the generic methodology seeded from `templates/` (only where absent). `OFFICE_SEED=full` also seeds the ten agent personas (disabled).
3. Download the newest `office-YYYYMMDD-HHMM.tar.gz.gpg` from your backup folder on Drive (browser is fine). The passphrase is kept by the owner, never in this repo.
4. `bash scripts/restore.sh ~/Downloads/office-....tar.gz.gpg` : asks for the passphrase, decrypts, verifies the manifest, restores the tenant (store, tasks, skills, agents, secrets, config), the user layer (`~/.claude/skills`, user units, `office-say`, project memory), and clones the own repos that are missing. Use `--dry-run` to only verify, `--no-repos` to skip the clones.
   - An existing tenant store is refused unless you stop the engine and pass `--force`.
5. `systemctl --user daemon-reload && systemctl --user restart theoffice`; open the dashboard and check agents, tasks and memory counts.
6. Only if an app database itself was lost: re-import its dump from the archive (e.g. `db-export/*.sql`, `wrangler d1 execute`) and copy any app data directory (e.g. `app-data/`) back into its repo after it is cloned.

## Proof it works

A full restore into a scratch directory is diffed against the live office after changes to the backup/restore tooling: scheduled tasks, skills, units, config, tools, secrets and agent files must be identical, and the store must restore with the same memory count.

## Keeping it true

`tools/office_export.py` runs nightly (via the off-box code sync): it exports the generic half, scans for secrets and personal data, holds any file with an unreviewed name-like word, and checks that every local office file is either exported or inside the latest backup. Anything in neither is reported as a problem.

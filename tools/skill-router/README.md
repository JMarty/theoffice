# skill-router

A `UserPromptSubmit` hook. When a prompt mentions a topic that has a skill, it injects "invoke skill X first, read it in full, re-open it before each step". Silent when nothing matches.

- `route.py`: the hook. Generic routes are in the file; tenant-specific routes are read from `$OFFICE_TENANT_ROOT/config/skill-routes.json` as `[["regex", "skill-name"], ...]` (not committed, travels in the encrypted backup). New skill = add a route there and test: `echo '{"prompt":"..."}' | python3 route.py`.
- `install_hook.py`: merges the hook into `~/.claude/settings.json` (idempotent, keeps all other hooks, writes `.bak-skillrouter`). `scripts/install.sh` runs it; `OFFICE_SKILL_ROUTER=0` skips it; `--remove` takes it out.

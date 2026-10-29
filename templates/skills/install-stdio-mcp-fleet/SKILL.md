---
name: install-stdio-mcp-fleet
description: Install a third-party stdio MCP server (from a GitHub repo or npm) and wire it into specific marveen fleet agents via .mcp.json. Use when Owner links an MCP repo and says "install this", "add this MCP", "I want X MCP" (e.g. Waze, a weather MCP, etc.).
---
# Install a stdio MCP for the fleet

## When to use
- Owner links a GitHub/npm MCP server and wants it usable by one or more agents.
- Different from `fleet-mcp-connector-access` (that handles claude.ai account connectors, which are inherited and gated by deny rules). THIS is for locally-installed stdio MCP servers.

## OWNERSHIP (read first)
MCP installs / deploys / tmux / systemd are **Darryl's domain** (infrastructure). If you are Michael/marveen, DELEGATE this to darryl via inter-agent message rather than running it inline — even if you're already in the files. Coordinate, don't execute infra. This skill is the playbook Darryl (or whoever owns the task) follows.

## Procedure
1. Inspect the repo first (WebFetch the README): language/runtime, entrypoint, deps, whether it needs an API key, the tools it exposes, and the example client config (command + args).
2. Clone to a shared tools dir: `git clone --depth 1 <url> <old-install>/tools/<name>`.
3. SECURITY AUDIT before building (it runs on Owner's machine):
   - `grep -rhoE "https?://[^\"' ]+" src/` -> confirm outbound hosts are only the expected service.
   - `grep -rnE "child_process|exec|spawn|eval|process\.env|require\('fs'\)|from 'fs'" src/` -> flag anything that touches shell/fs/secrets unexpectedly.
   - Check package.json deps are minimal/known.
4. Build: `npm install && npm run build` (Node/TS) or per the repo. Confirm the entrypoint (e.g. `dist/index.js`) exists, 0 vulns.
5. SMOKE TEST over stdio JSON-RPC before declaring done. Pipe newline-delimited:
   - initialize -> notifications/initialized -> tools/call with a REAL example
   - `printf '%s\n' '<init>' '<initialized>' '<tools/call>' | timeout 40 node dist/index.js`
   - Verify a real result comes back (e.g. a real travel time), not an error.
6. Wire into agents that need it via `.mcp.json` `mcpServers`:
   - marveen (main agent): project-root `<old-install>/.mcp.json` (create if missing).
   - any sub-agent: `agents/<name>/.mcp.json` (MERGE into existing mcpServers, don't clobber gmail/etc.).
   - Config: `{"command":"node","args":["/abs/path/dist/index.js"],"env":{}}`
7. Make agents AWARE: add a short usage note to the relevant CLAUDE.md (and patch any skill that should use it, e.g. morning-briefing-compose for drive times).
8. Restart sub-agents to load the new MCP (stop+start, then clear the Remote Control modal). marveen itself only picks it up on ITS next restart — don't self-restart mid-conversation; tell Owner it goes live next cycle.

## Pitfalls
- `.mcp.json` is PROJECT-SCOPED. Agents launched by the dashboard with `--dangerously-skip-permissions` auto-trust project MCP servers. Running `claude mcp list` WITHOUT that flag shows them as "⏸ Pending approval" — that's a false alarm from the unprivileged list command, not the agent's real state (gmail shows the same and works fine).
- A running session does NOT hot-reload `.mcp.json`. The MCP only appears after the agent restarts. marveen = the main session; adding to root `.mcp.json` needs a marveen restart to take effect.
- Don't clobber an agent's existing `.mcp.json` (gmail/gdrive/homeassistant). Always merge.
- Audit BEFORE build/run — `npm install` can execute postinstall scripts.

## Verification
- Smoke test returned a real result over stdio.
- `.mcp.json` entries valid JSON, abs paths, existing servers preserved.
- Sub-agents restarted + modal cleared; CLAUDE.md/skill updated; Owner told what's live now vs after marveen's next restart.

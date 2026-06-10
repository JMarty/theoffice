// Launch one agent's pure `claude` tmux session via the engine's launchAgent.
// Usage: node scripts/launch-agent.mjs <agentId>
import { loadConfig } from "../dist/config.js";
import { loadAgents } from "../dist/agents.js";
import { launchAgent, sessionNameFor } from "../dist/session/session-manager.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: node scripts/launch-agent.mjs <agentId>");
  process.exit(1);
}
const cfg = loadConfig();
const agent = loadAgents(cfg).find((a) => a.id === id);
if (!agent) {
  console.error(`no such agent: ${id}`);
  process.exit(1);
}
const ok = launchAgent(cfg, agent);
console.log(ok ? `launched ${id} -> session ${sessionNameFor(id)}` : `not launched (already running?) ${id}`);

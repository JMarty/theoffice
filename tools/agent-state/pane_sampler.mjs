// Samples an agent's tmux pane with the engine's own detectPaneState() and appends "<ms>\t<state>" to <dir>/<agent>.pane.log.
// Runs ~55 s per invocation (every 5 s), started by a 1-minute timer, so the trial has a pane reading to compare the hook-derived state against.
// Read-only: capture-pane only, never a keystroke.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.OFFICE_ROOT || new URL("../../", import.meta.url).pathname;
const tenant = process.env.OFFICE_TENANT_ROOT || join(root, "tenant");
const dir = process.env.AGENT_STATE_DIR || join(tenant, "store", "agent-state");
const socket = process.env.OFFICE_TMUX_SOCKET || "theoffice";
const agents = (process.env.AGENT_STATE_AGENTS || "darryl").split(",").map((s) => s.trim()).filter(Boolean);
const { detectPaneState } = await import(pathToFileURL(join(root, "dist", "session", "pane-state.js")).href);

mkdirSync(dir, { recursive: true });
const sample = () => {
  for (const a of agents) {
    let state = "unknown";
    try {
      const pane = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", `agent-${a}`], { encoding: "utf8", timeout: 3000 });
      state = detectPaneState(pane);
    } catch { /* no session: unknown */ }
    appendFileSync(join(dir, `${a}.pane.log`), `${Date.now()}\t${state}\n`);
  }
};
for (let i = 0; i < 11; i++) {
  sample();
  await new Promise((r) => setTimeout(r, 5000));
}

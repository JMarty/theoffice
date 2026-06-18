import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { newSession, sessionNameFor } from "./tmux.js";
import { writeAgentSettings } from "./profile.js";
import { buildAgentEnv } from "./agent-env.js";
import { markDelivering, markDelivered, markFailed, requeue, requeueNoPenalty } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import { decideCodexOutcome } from "./exec-outcome.js";
import type { Runtime, QueuedItem } from "./runtime.js";

/**
 * Codex runtime path (Pete-on-Codex pilot). A `runtime: "codex"` agent does NOT run a persistent TUI
 * we inject into; instead each queued prompt is one `codex exec --json` subprocess, and completion is
 * the structured `turn.completed` event (validated by the spike) — far more robust than scraping a TUI.
 *
 * The tmux session for a codex agent is just an idle HOLDER so the agent shows "running" and the
 * lifecycle/reaper see it; the real work runs in the exec subprocess, not the pane. office-say + the
 * dashboard curl work inside the exec via the same .reply-context + OFFICE_* env as the claude path —
 * fully model-agnostic.
 *
 * This whole module is inert until an agent's runtime flag is flipped to "codex" (the gated cutover).
 */
const logger = log("codex");
const MAX_DELIVERY_ATTEMPTS = 5;
// On a ChatGPT usage cap (rolling 5h / weekly window, SHARED with the owner's own ChatGPT/Codex use) we
// hold delivery rather than burn retries: the cap is transient, so we wait then try again. 15 min is gentle
// and will succeed once the window rolls. If codex ever surfaces an exact reset time we can honor it here.
const USAGE_BACKOFF_MS = 15 * 60_000;
// Node-side watchdog: if `codex exec` wedges (no `close` ever fires), the agent would stay inFlight FOREVER
// and the deliverer would skip every future message for it ("received but didn't act", only an engine
// restart heals it). Kill a turn that overruns this so the item requeues and the agent frees up. Generous:
// a real turn (tool calls, edits) finishes well inside this; only a genuine hang trips it.
const TURN_TIMEOUT_MS = 14 * 60_000;
// Heuristic match on codex output for "you hit a usage/rate limit" across stdout JSON + stderr text.
const USAGE_LIMIT_RE =
  /usage limit|rate limit|too many requests|quota|\b429\b|try again later|limit reached|reached your .*limit|you (?:have|'ve) hit/i;

// agents with a codex exec currently running -> skip new delivery for them until it finishes
const inFlight = new Set<string>();
// agentId -> epoch ms until which we hold delivery after hitting a usage cap (transient back-off)
const cooldownUntil = new Map<string, number>();

export function isCodexBusy(agentId: string): boolean {
  if (inFlight.has(agentId)) return true;
  const until = cooldownUntil.get(agentId);
  if (until && Date.now() < until) return true; // in usage-cap back-off -> leave items queued, no attempt burned
  return false;
}

/**
 * Launch an idle tmux HOLDER for a codex agent (so it reads as "running" + the reaper keeps it).
 * The actual turns run as `codex exec` subprocesses against agent.dir, not in this pane.
 */
export function launchCodexHolder(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = sessionNameFor(agent.id);
  // benign idle process; never accepts injected input — codex work is the exec subprocess
  const command = ["bash", "-lc", "echo 'codex holder (work runs via codex exec)'; exec sleep infinity"];
  writeAgentSettings(cfg, agent); // keep the security profile regen parity with the claude path
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env: buildAgentEnv(cfg, agent) });
  logger.info({ agent: agent.id, session, ok }, ok ? "launched codex holder" : "codex holder skipped (exists?)");
  return ok;
}

/**
 * Deliver one prompt to a codex agent: spawn `codex exec --json` async, key completion off the
 * `turn.completed` event, then mark the queue item delivered. NON-BLOCKING — returns immediately and
 * tracks in-flight so the deliverer loop is never stalled for other agents.
 */
export function deliverCodexPrompt(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): void {
  if (inFlight.has(agent.id)) return;

  const env = buildAgentEnv(cfg, agent);
  if (item.source === "channel" && item.reply_channel) {
    env.OFFICE_REPLY_CHANNEL = item.reply_channel;
    try {
      writeFileSync(join(agent.dir, ".reply-context"), item.reply_channel);
    } catch {
      /* best-effort */
    }
  }
  const prompt = item.source === "channel" ? `[Slack message from the owner]\n\n${item.prompt}` : item.prompt;
  // unattended posture, same spirit as claude's --dangerously-skip-permissions (the box is the boundary):
  // no approval prompts, no sandbox restriction so the agent can office-say / git / write the vault.
  const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt];

  let sawCompleted = false;
  let sawUsageLimit = false;
  let buf = "";

  // Mark busy + charge the attempt only once we are actually about to spawn. A synchronous spawn throw
  // (e.g. a broken cwd) must NOT leave the agent stuck inFlight, so the add is paired with try/catch.
  inFlight.add(agent.id);
  markDelivering(item.id);

  // settle() runs the chosen terminal move exactly once, no matter which of close/error/timeout wins the race.
  let settled = false;
  const settle = (timedOut: boolean, code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    inFlight.delete(agent.id);
    const outcome = decideCodexOutcome({ code, sawCompleted, sawUsageLimit, timedOut });
    if (outcome.kind === "delivered") {
      markDelivered(item.id);
      recordInbound(item.agent_id, item.reply_channel, item.prompt);
      logger.info({ id: item.id, agent: agent.id }, "codex prompt delivered (turn.completed)");
    } else if (outcome.kind === "usage") {
      cooldownUntil.set(agent.id, Date.now() + USAGE_BACKOFF_MS);
      requeueNoPenalty(item.id);
      logger.warn(
        { id: item.id, agent: agent.id, backoffMin: USAGE_BACKOFF_MS / 60_000 },
        "codex usage cap -> holding (no attempt charged)",
      );
    } else if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
      markFailed(item.id, outcome.why);
      logger.warn({ id: item.id, agent: agent.id, why: outcome.why, code }, "codex delivery failed (max attempts)");
    } else {
      requeue(item.id);
      logger.warn({ id: item.id, agent: agent.id, why: outcome.why, code }, "codex exec not clean -> requeued");
    }
  };

  let child: ReturnType<typeof spawn>;
  try {
    // CRITICAL: stdin must be /dev/null (EOF), NOT an open pipe. `codex exec` reads stdin for "additional
    // input" after the positional prompt; node's default stdio leaves stdin open, so codex blocks forever
    // (futex wait, no session, no turn). "ignore" gives it immediate EOF so the turn runs. (Root cause of the
    // first cutover smoke-test hang — 2026-06-12.)
    child = spawn("codex", args, { cwd: agent.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    inFlight.delete(agent.id);
    requeue(item.id);
    logger.warn({ id: item.id, agent: agent.id, err }, "codex spawn threw -> requeued (agent freed)");
    return;
  }

  const watchdog = setTimeout(() => {
    logger.warn({ id: item.id, agent: agent.id, timeoutMin: TURN_TIMEOUT_MS / 60_000 }, "codex turn wedged -> SIGKILL");
    child.kill("SIGKILL");
    settle(true, null);
  }, TURN_TIMEOUT_MS);

  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        if (JSON.parse(line)?.type === "turn.completed") sawCompleted = true;
      } catch {
        /* non-JSON line, ignore */
      }
      if (USAGE_LIMIT_RE.test(line)) sawUsageLimit = true; // error events sometimes ride on stdout
    }
  });
  // codex surfaces auth/limit errors on stderr too
  child.stderr?.on("data", (d: Buffer) => {
    if (USAGE_LIMIT_RE.test(d.toString())) sawUsageLimit = true;
  });

  child.on("close", (code) => settle(false, code));
  child.on("error", (err) => {
    logger.warn({ id: item.id, agent: agent.id, err: String((err as Error).message ?? err) }, "codex spawn error");
    settle(false, null);
  });
}

export const codexRuntime: Runtime = {
  id: "codex",
  label: "OpenAI Codex (GPT-5.5)",
  // Codex uses the signed-in ChatGPT account's model, not a per-launch flag, so no selectable list.
  models: [],
  launch: launchCodexHolder,
  isBusy: isCodexBusy,
  // HOLDER-style: the dashboard can't read a Claude pane, so report live state from the exec tracker.
  liveState: (agentId) => (isCodexBusy(agentId) ? "busy" : "idle"),
  deliver: deliverCodexPrompt,
};

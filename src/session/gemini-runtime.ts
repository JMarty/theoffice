import { spawn } from "node:child_process";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { newSession, sessionNameFor } from "./tmux.js";
import { writeAgentSettings } from "./profile.js";
import { buildAgentEnv } from "./agent-env.js";
import { markDelivering, markDelivered, markFailed, requeue, requeueNoPenalty } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import { decideGeminiOutcome } from "./exec-outcome.js";
import type { Runtime, QueuedItem } from "./runtime.js";

/**
 * Gemini runtime — drives an agent on Google's Antigravity CLI (`agy`), the successor to the Gemini CLI
 * (Google sunsets Gemini CLI consumer access on 2026-06-18; Antigravity is the surviving path for a
 * Google AI Pro/Ultra subscription). Modelled on the codex runtime: a `runtime: "gemini"` agent does NOT
 * run a persistent TUI we inject into — each queued prompt is one `agy --print` subprocess and completion
 * is the process exiting cleanly (code 0) WITH output. Antigravity's print mode emits the final answer as
 * plain text rather than a structured turn event, so completion is keyed off the exit code + non-empty
 * output, not a JSON marker.
 *
 * The tmux session for a gemini agent is just an idle HOLDER so the agent reads as "running" and the
 * reaper keeps it; the real work runs in the `agy` subprocess. office-say + the dashboard curl work
 * inside the exec via the same .reply-context + OFFICE_* env as the claude/codex paths — model-agnostic.
 *
 * Inert until an agent's runtime flag is flipped to "gemini" (the gated cutover). Auth is the owner's
 * one-time `agy` sign-in (browser/SSH device-style URL) against their subscription account.
 */
const logger = log("gemini");
const MAX_DELIVERY_ATTEMPTS = 5;
// On a subscription usage cap (Antigravity's rolling window, shared with the owner's own Antigravity use)
// hold delivery rather than burn retries: the cap is transient, so we wait then try again.
const USAGE_BACKOFF_MS = 15 * 60_000;
// `agy --print` waits up to --print-timeout (default 5m). Give the turn generous headroom.
const PRINT_TIMEOUT = "10m";
// Node-side watchdog backstop OUTSIDE the CLI's own --print-timeout: if `agy` itself wedges (process never
// exits, so `close` never fires), the agent would stay inFlight forever and the deliverer would skip every
// future message for it. Set comfortably above PRINT_TIMEOUT so the CLI's own timeout normally wins.
const TURN_TIMEOUT_MS = 14 * 60_000;
// Heuristic match for "you hit a usage/rate/quota limit" across stdout + stderr.
const USAGE_LIMIT_RE =
  /usage limit|rate limit|too many requests|quota|\b429\b|try again later|limit reached|reached your .*limit|resource exhausted/i;

// agents with an `agy` exec currently running -> skip new delivery for them until it finishes
const inFlight = new Set<string>();
// agentId -> epoch ms until which we hold delivery after hitting a usage cap (transient back-off)
const cooldownUntil = new Map<string, number>();

export function isGeminiBusy(agentId: string): boolean {
  if (inFlight.has(agentId)) return true;
  const until = cooldownUntil.get(agentId);
  if (until && Date.now() < until) return true; // in usage-cap back-off -> leave items queued, no attempt burned
  return false;
}

/**
 * Launch an idle tmux HOLDER for a gemini agent (so it reads as "running" + the reaper keeps it).
 * The actual turns run as `agy --print` subprocesses against agent.dir, not in this pane.
 */
export function launchGeminiHolder(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = sessionNameFor(agent.id);
  const command = ["bash", "-lc", "echo 'gemini holder (work runs via agy --print)'; exec sleep infinity"];
  writeAgentSettings(cfg, agent); // keep the security profile regen parity with the claude/codex paths
  // Antigravity's `agy` reads its persona/instructions from AGENTS.md, NOT CLAUDE.md (verified live
  // 2026-06-15: without this, agy thinks it's a generic "Antigravity" assistant and ignores the agent's
  // role + the office-say reply protocol). Expose the agent's CLAUDE.md as AGENTS.md via a relative
  // symlink so there's a single source of truth. Idempotent: EEXIST is the normal steady state.
  try {
    symlinkSync("CLAUDE.md", join(agent.dir, "AGENTS.md"));
  } catch {
    /* already linked (EEXIST) or fs without symlinks — best-effort */
  }
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env: buildAgentEnv(cfg, agent) });
  logger.info({ agent: agent.id, session, ok }, ok ? "launched gemini holder" : "gemini holder skipped (exists?)");
  return ok;
}

/**
 * Deliver one prompt to a gemini agent: spawn `agy --print` async, key completion off a clean exit WITH
 * output, then mark the queue item delivered. NON-BLOCKING — returns immediately and tracks in-flight so
 * the deliverer loop is never stalled for other agents.
 */
export function deliverGeminiPrompt(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): void {
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
  // Flags BEFORE the prompt value (Go flag parsing stops at the first non-flag arg). Model selection is
  // left to the agent's signed-in default unless agent.model overrides it. Unattended posture mirrors the
  // claude/codex paths: --dangerously-skip-permissions so the agent can office-say / git / write the vault.
  const args = ["--dangerously-skip-permissions", "--print-timeout", PRINT_TIMEOUT];
  if (agent.model && agent.model !== "default") args.push("--model", agent.model);
  args.push("--print", prompt);

  let sawUsageLimit = false;
  let sawOutput = false;
  // Only STDOUT counts as "the model produced an answer". stderr (progress lines, deprecation banners —
  // `agy` is being sunset) must NEVER set sawOutput, or an empty-answer turn that merely logged to stderr
  // would be falsely marked delivered and the Slack message lost. stderr only ever feeds the usage signal,
  // exactly like the codex path.
  const scanUsage = (s: string) => {
    if (USAGE_LIMIT_RE.test(s)) sawUsageLimit = true;
  };

  inFlight.add(agent.id);
  markDelivering(item.id);

  let settled = false;
  const settle = (timedOut: boolean, code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    inFlight.delete(agent.id);
    const outcome = decideGeminiOutcome({ code, sawUsageLimit, sawOutput, timedOut });
    if (outcome.kind === "delivered") {
      markDelivered(item.id);
      recordInbound(item.agent_id, item.reply_channel, item.prompt);
      logger.info({ id: item.id, agent: agent.id }, "gemini prompt delivered (clean exit + output)");
    } else if (outcome.kind === "usage") {
      cooldownUntil.set(agent.id, Date.now() + USAGE_BACKOFF_MS);
      requeueNoPenalty(item.id);
      logger.warn(
        { id: item.id, agent: agent.id, backoffMin: USAGE_BACKOFF_MS / 60_000 },
        "gemini usage cap -> holding (no attempt charged)",
      );
    } else if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
      markFailed(item.id, outcome.why);
      logger.warn({ id: item.id, agent: agent.id, why: outcome.why, code }, "gemini delivery failed (max attempts)");
    } else {
      requeue(item.id);
      logger.warn({ id: item.id, agent: agent.id, why: outcome.why, code }, "gemini exec not clean -> requeued");
    }
  };

  let child: ReturnType<typeof spawn>;
  try {
    // stdin = /dev/null (EOF) so `agy` never blocks waiting for interactive follow-up input (same trap the
    // codex path hit). stdout carries the printed answer; we track whether anything was actually printed.
    child = spawn("agy", args, { cwd: agent.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    inFlight.delete(agent.id);
    requeue(item.id);
    logger.warn({ id: item.id, agent: agent.id, err }, "gemini spawn threw -> requeued (agent freed)");
    return;
  }

  const watchdog = setTimeout(() => {
    logger.warn({ id: item.id, agent: agent.id, timeoutMin: TURN_TIMEOUT_MS / 60_000 }, "gemini turn wedged -> SIGKILL");
    child.kill("SIGKILL");
    settle(true, null);
  }, TURN_TIMEOUT_MS);

  child.stdout?.on("data", (d: Buffer) => {
    const s = d.toString();
    if (s.trim()) sawOutput = true; // real bytes on STDOUT = the turn actually produced an answer
    scanUsage(s);
  });
  child.stderr?.on("data", (d: Buffer) => scanUsage(d.toString())); // stderr never counts as output

  child.on("close", (code) => settle(false, code));
  child.on("error", (err) => {
    logger.warn({ id: item.id, agent: agent.id, err: String((err as Error).message ?? err) }, "gemini spawn error");
    settle(false, null);
  });
}

export const geminiRuntime: Runtime = {
  id: "gemini",
  label: "Google Antigravity (Gemini)",
  // Selectable `--model` values, exactly as `agy models` advertises them for a Google AI Pro account
  // (verified live 2026-06-15). Empty agent.model -> the provider/account default (Gemini 3.5 Flash).
  models: [
    "Gemini 3.5 Flash (Low)",
    "Gemini 3.5 Flash (Medium)",
    "Gemini 3.5 Flash (High)",
    "Gemini 3.1 Pro (Low)",
    "Gemini 3.1 Pro (High)",
  ],
  launch: launchGeminiHolder,
  isBusy: isGeminiBusy,
  // HOLDER-style: the dashboard can't read a Claude pane, so report live state from the exec tracker.
  liveState: (agentId) => (isGeminiBusy(agentId) ? "busy" : "idle"),
  deliver: deliverGeminiPrompt,
};

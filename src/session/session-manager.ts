import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "../env.js";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import {
  capturePane,
  clearInput,
  hasSession,
  newSession,
  sendKey,
  sendText,
} from "./tmux.js";
import { detectPaneState, decideSubmitFollowup } from "./pane-state.js";
import { writeAgentSettings } from "./profile.js";
import { ensureFolderTrusted } from "./trust.js";
import { listQueued, markDelivering, markDelivered, markFailed, requeue } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import { loadAgents } from "../agents.js";

const logger = log("session");

// Tunables (ported from v1's hard-won values).
const CHUNK = 180; // chars per send-keys -l burst
const SETTLE_CHUNK_MS = 30; // between chunks
const SETTLE_BEFORE_ENTER_MS = 150; // let bracketed-paste finish before Enter
const SUBMIT_RETRY_MAX = 4; // retry-Enter attempts after the first send
const SUBMIT_RETRY_POLL_MS = 1000; // wait between confirm samples
const READY_SAMPLE_GAP_MS = 250; // double-sample idle gap
const DELIVERER_TICK_MS = 2000; // queue drain cadence
const MAX_DELIVERY_ATTEMPTS = 5; // give up + mark failed after this many

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Session name convention for an agent. */
export function sessionNameFor(agentId: string): string {
  return `agent-${agentId}`;
}

/**
 * Record where an agent should reply for a channel-sourced message. The `office-say`
 * helper reads this file so the agent can just run `office-say "..."` without knowing
 * the Slack channel id. Written right before delivery.
 */
function writeReplyContext(cfg: EngineConfig, agentId: string, channel: string): void {
  try {
    writeFileSync(join(cfg.paths.agentsDir, agentId, ".reply-context"), channel);
  } catch {
    /* best-effort */
  }
}

/** Tag a channel message so the agent knows it came from the owner via Slack. */
function wrapForDelivery(source: string, prompt: string): string {
  return source === "channel" ? `[Slack message from the owner]\n\n${prompt}` : prompt;
}

/**
 * Double-sampled readiness: capture twice with a small gap; ready only if BOTH
 * frames classify idle. Catches the one-frame footer gap right after a submit.
 */
async function isReady(socket: string, session: string): Promise<boolean> {
  const a = capturePane(socket, session);
  if (a == null || detectPaneState(a) !== "idle") return false;
  await sleep(READY_SAMPLE_GAP_MS);
  const b = capturePane(socket, session);
  return b != null && detectPaneState(b) === "idle";
}

export interface DeliveryResult {
  ok: boolean;
  reason?: "not-ready" | "wedged" | "submit-give-up" | "no-session";
}

/**
 * Idempotent delivery of one prompt into an agent's pure `claude` session.
 * Safe to re-call: it clears any stray draft first and confirms the submit
 * landed before returning ok. This single function replaces v1's scattered
 * send / stuck-input / idle-submit machinery.
 */
export async function deliverPrompt(socket: string, session: string, prompt: string): Promise<DeliveryResult> {
  if (!hasSession(socket, session)) return { ok: false, reason: "no-session" };

  const pre = capturePane(socket, session);
  if (pre == null) return { ok: false, reason: "not-ready" };
  const state = detectPaneState(pre);
  if (state === "error") return { ok: false, reason: "wedged" };
  if (state === "typing") clearInput(socket, session); // remove a stray draft before sending
  if (state === "busy" || state === "unknown") return { ok: false, reason: "not-ready" };

  // type the prompt in literal chunks
  for (let i = 0; i < prompt.length; i += CHUNK) {
    sendText(socket, session, prompt.slice(i, i + CHUNK));
    if (i + CHUNK < prompt.length) await sleep(SETTLE_CHUNK_MS);
  }
  await sleep(SETTLE_BEFORE_ENTER_MS);
  sendKey(socket, session, "Enter");

  // confirm the submit actually landed; retry Enter within a bounded budget
  const hint = prompt.slice(0, Math.min(prompt.length, 40));
  for (let attempt = 0; attempt <= SUBMIT_RETRY_MAX; attempt++) {
    await sleep(SUBMIT_RETRY_POLL_MS);
    const pane = capturePane(socket, session);
    const action = decideSubmitFollowup(pane, hint, attempt, SUBMIT_RETRY_MAX);
    if (action === "done") return { ok: true };
    if (action === "give-up") return { ok: false, reason: "submit-give-up" };
    sendKey(socket, session, "Enter");
  }
  return { ok: false, reason: "submit-give-up" };
}

/**
 * Launch a PURE `claude` session for an agent (NO channel plugin inside — the
 * Slack channel is external). Env is command-scoped so it never leaks to siblings.
 */
export function launchAgent(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = sessionNameFor(agent.id);
  const command = ["claude", "--dangerously-skip-permissions"];
  if (agent.model) command.push("--model", agent.model);
  const home = process.env.HOME ?? "";
  const env: Record<string, string> = {
    // ~/.local/bin first so the agent can call `office-say` to reply on Slack
    PATH: `${home}/.local/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    TZ: cfg.owner.timezone,
    HOME: home,
    OFFICE_AGENT_ID: agent.id,
    OFFICE_TENANT_ROOT: cfg.paths.tenantRoot,
    OFFICE_PORT: String(cfg.web.port),
  };
  // per-agent secrets/env (e.g. an API key for one agent, scoped Drive creds for another)
  for (const [k, v] of Object.entries(readEnvFile(join(agent.dir, ".env")))) env[k] = v;
  // regenerate the agent's security profile (connector + filesystem deny) before launch
  writeAgentSettings(cfg, agent);
  // pre-accept Claude's folder-trust gate; otherwise a fresh pane blocks on the
  // interactive "trust this folder?" prompt forever and never reaches idle, so
  // the deliverer can never hand it a message (and --dangerously-skip-permissions
  // does NOT bypass that prompt). Idempotent.
  ensureFolderTrusted(agent.dir);
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env });
  logger.info({ agent: agent.id, session, ok }, ok ? "launched agent" : "launch skipped (exists?)");
  return ok;
}

/**
 * Launch every enabled agent that isn't already running. Called once at boot so
 * the fleet comes up on its own after a reboot — without this, a fresh tmux
 * server (only __keepalive) has no agent sessions and nothing relaunches them,
 * so inbound messages pile up undelivered until someone clicks "start" in the
 * dashboard. Idempotent: skips agents whose session already exists.
 */
export function launchEnabledAgents(cfg: EngineConfig): void {
  const socket = cfg.tmux.socket;
  let launched = 0;
  for (const agent of loadAgents(cfg)) {
    if (!agent.enabled) continue;
    if (hasSession(socket, sessionNameFor(agent.id))) continue; // already up — leave it
    if (launchAgent(cfg, agent)) launched++;
  }
  logger.info({ launched }, "autostart: launched enabled agents");
}

/**
 * The single deliverer loop. Drains the inbound queue: for each queued item whose
 * target session is running AND idle, deliver exactly once. Not-ready items stay
 * queued for the next tick (no attempt burned). This is the only writer to a pane.
 */
export function startDeliverer(cfg: EngineConfig): () => void {
  const socket = cfg.tmux.socket;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      for (const item of listQueued()) {
        const session = sessionNameFor(item.agent_id);
        if (!hasSession(socket, session)) continue; // agent not running -> leave queued
        if (!(await isReady(socket, session))) continue; // busy/typing/wedged -> retry next tick

        if (item.source === "channel" && item.reply_channel) {
          writeReplyContext(cfg, item.agent_id, item.reply_channel);
        }
        markDelivering(item.id);
        const res = await deliverPrompt(socket, session, wrapForDelivery(item.source, item.prompt));
        if (res.ok) {
          markDelivered(item.id);
          recordInbound(item.agent_id, item.reply_channel, item.prompt);
          logger.info({ id: item.id, agent: item.agent_id, source: item.source }, "delivered");
        } else if (res.reason === "wedged") {
          markFailed(item.id, "session wedged (thinking-block error)");
          logger.warn({ id: item.id, agent: item.agent_id }, "agent wedged — needs reset");
        } else if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
          markFailed(item.id, res.reason ?? "unknown");
          logger.warn({ id: item.id, agent: item.agent_id, reason: res.reason }, "delivery failed (max attempts)");
        } else {
          requeue(item.id);
        }
      }
    } catch (err) {
      logger.error({ err }, "deliverer tick error");
    }
  };

  const handle = setInterval(() => void tick(), DELIVERER_TICK_MS);
  logger.info({ socket, tickMs: DELIVERER_TICK_MS }, "deliverer started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

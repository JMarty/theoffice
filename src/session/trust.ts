import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../logger.js";

const logger = log("trust");

interface ClaudeProject {
  hasTrustDialogAccepted?: boolean;
  [k: string]: unknown;
}
interface ClaudeConfig {
  projects?: Record<string, ClaudeProject>;
  [k: string]: unknown;
}

/**
 * Pre-accept Claude Code's folder-trust gate for an agent's working directory.
 *
 * A freshly-launched `claude` in a never-before-seen directory blocks on the
 * interactive "Is this a project you trust? 1. Yes / 2. No" prompt — and
 * `--dangerously-skip-permissions` does NOT bypass it (anthropics/claude-code
 * #28506 / #36342). In an automated tmux launch nothing types "1", so the pane
 * never reaches idle and the deliverer can never hand it a message: the agent
 * looks dead while the inbound queue silently piles up.
 *
 * We persist the very same `hasTrustDialogAccepted` flag Claude itself writes to
 * ~/.claude.json, so the session boots straight to the prompt. Idempotent, and
 * it preserves every other key in the file (read-modify-write + atomic rename).
 */
export function ensureFolderTrusted(agentDir: string): void {
  const home = process.env.HOME;
  if (!home) return;
  const cfgPath = join(home, ".claude.json");
  const dir = resolve(agentDir);
  try {
    if (!existsSync(cfgPath)) return; // claude not initialised yet — nothing safe to seed
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as ClaudeConfig;
    cfg.projects ??= {};
    const existing = cfg.projects[dir];
    if (existing?.hasTrustDialogAccepted) return; // already trusted — leave Claude's own state alone
    cfg.projects[dir] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
    const tmp = `${cfgPath}.office-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, cfgPath); // atomic: never leaves a half-written ~/.claude.json
    logger.info({ dir }, "pre-accepted folder trust");
  } catch (err) {
    logger.warn({ dir, err }, "could not pre-seed folder trust (agent may block on the trust prompt)");
  }
}

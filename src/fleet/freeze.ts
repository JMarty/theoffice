import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";

/**
 * Fleet freeze (the red button): while <store>/fleet-freeze.json exists, no agent may run a tool (a PreToolUse hook rejects every call,
 * see tools/fleet-freeze) and the engine's own loops (scheduler, deliverer) stand still. Sessions and their context survive, so
 * thawing resumes where things were. The switch is a FILE so the hook needs no engine, and a missing engine cannot hold the fleet frozen
 * or thawed by accident. An unreadable file still means frozen (fail closed). Anyone with the dashboard token, including an agent, may
 * freeze; only the owner may thaw: a Slack command from the owner's own user id, or deleting the file on the machine. There is no
 * unfreeze API on purpose: every agent holds the dashboard token.
 */
export const FREEZE_FILE = "fleet-freeze.json";
const REASON_MAX = 300;

export interface FreezeState {
  frozen: boolean;
  reason?: string;
  by?: string;
  at?: number;
}

const path = (cfg: EngineConfig): string => join(cfg.paths.storeDir, FREEZE_FILE);

export function isFrozen(cfg: EngineConfig): boolean {
  if (!cfg.paths?.storeDir) return false; // a config with no store directory (minimal test configs) has no freeze file
  return existsSync(path(cfg));
}

export function freezeState(cfg: EngineConfig): FreezeState {
  if (!isFrozen(cfg)) return { frozen: false };
  try {
    const j = JSON.parse(readFileSync(path(cfg), "utf8")) as { reason?: string; by?: string; at?: number };
    return { frozen: true, reason: j.reason, by: j.by, at: j.at };
  } catch {
    return { frozen: true, reason: "freeze file unreadable" };
  }
}

/** Freeze. A second freeze keeps the first reason and author: the cause of the stop is never overwritten. */
export function freezeFleet(cfg: EngineConfig, reason: string, by: string, nowSec = Math.floor(Date.now() / 1000)): FreezeState {
  if (isFrozen(cfg)) return freezeState(cfg);
  mkdirSync(cfg.paths.storeDir, { recursive: true });
  writeFileSync(path(cfg), JSON.stringify({ reason: reason.slice(0, REASON_MAX), by, at: nowSec }), { mode: 0o600 });
  try {
    chmodSync(path(cfg), 0o600);
  } catch {
    /* best effort */
  }
  return freezeState(cfg);
}

/** Thaw. True if the fleet was frozen. Callers must be owner-authenticated paths only. */
export function unfreezeFleet(cfg: EngineConfig): boolean {
  if (!isFrozen(cfg)) return false;
  rmSync(path(cfg), { force: true });
  return true;
}

/**
 * The owner's own Slack phrasings. Deliberately strict: a whole-message command, so chat that merely mentions freezing ("can you
 * unfreeze the budget?") never triggers it. Accepts "/freeze [reason]", "!freeze [reason]", "freeze fleet [reason]" and the unfreeze
 * equivalents ("/unfreeze", "!unfreeze", "unfreeze fleet").
 */
export function parseOwnerFreezeCommand(text: string): { action: "freeze"; reason: string } | { action: "unfreeze" } | null {
  const t = text.trim();
  if (/^(?:[/!]unfreeze|unfreeze fleet)$/i.test(t)) return { action: "unfreeze" };
  const m = t.match(/^(?:[/!]freeze|freeze fleet)(?:\s+(.+))?$/i);
  if (m) return { action: "freeze", reason: m[1]?.trim() || "owner command" };
  return null;
}

/**
 * The owner's Slack command path. Acts ONLY when the sender is the owner's own Slack user id (the event comes from Slack with a verified
 * user, which no agent can forge; agents can only post as the bot). Returns the reply text if the message was a freeze/unfreeze command
 * (so the caller answers and does NOT forward it to an agent), or null for anything else, including the same words from anyone else.
 */
export function handleOwnerFreezeCommand(cfg: EngineConfig, text: string, senderId: string): string | null {
  const ownerId = cfg.owner?.slackUserId;
  if (!ownerId || senderId !== ownerId) return null;
  const cmd = parseOwnerFreezeCommand(text);
  if (!cmd) return null;
  if (cmd.action === "freeze") {
    const s = freezeFleet(cfg, cmd.reason, "owner");
    return `Fleet frozen: no agent can run a tool and no scheduled work starts. Reason: ${s.reason}. Reply "unfreeze fleet" to thaw.`;
  }
  return unfreezeFleet(cfg) ? "Fleet thawed: agents can work again, queued messages are being delivered." : "The fleet was not frozen.";
}

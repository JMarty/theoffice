import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig, AgentDef } from "../types.js";
import { REPO_ROOT } from "../config.js";
import { log } from "../logger.js";

const logger = log("profile");

interface ProfileDef {
  description?: string;
  deny?: string[];
}

/** Profiles that mean "no restriction" — full owner access. */
function isFullAccess(profile: string | undefined): boolean {
  return !profile || profile === "default" || profile === "full";
}

/**
 * Write tenant/agents/<id>/.claude/settings.json from the agent's security profile,
 * regenerated on every launch so it can't drift. The deny list combines:
 *   - the profile's connector denies (templates/profiles/<profile>.json)
 *   - runtime filesystem denies for sensitive, install-specific paths (other
 *     agents' secrets, the raw DB, the vault key) so a restricted agent can't
 *     read them off disk.
 * Full-access agents get any prior restrictive settings removed.
 */
export function writeAgentSettings(cfg: EngineConfig, agent: AgentDef): void {
  const settingsPath = join(agent.dir, ".claude", "settings.json");

  if (isFullAccess(agent.profile)) {
    // owner-only / trusted agent: ensure no stale restriction lingers
    if (existsSync(settingsPath)) rmSync(settingsPath);
    return;
  }

  const profPath = join(REPO_ROOT, "templates", "profiles", `${agent.profile}.json`);
  let prof: ProfileDef = {};
  try {
    prof = JSON.parse(readFileSync(profPath, "utf8")) as ProfileDef;
  } catch (err) {
    logger.error({ agent: agent.id, profile: agent.profile, err }, "profile not found — DENYING ALL connectors as a fail-safe");
    prof = { deny: ["mcp__claude_ai_*"] };
  }

  const deny = [...(prof.deny ?? [])];
  // runtime filesystem denies (sensitive paths) — defense in depth vs disk snooping
  deny.push(`Read(${cfg.paths.secretsDir}/**)`);
  deny.push(`Read(${cfg.paths.dbFile})`, `Read(${cfg.paths.dbFile}-wal)`, `Read(${cfg.paths.dbFile}-shm)`);
  deny.push(`Read(${cfg.paths.vaultKeyFile})`);

  const settings = { permissions: { deny } };
  mkdirSync(join(agent.dir, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logger.info({ agent: agent.id, profile: agent.profile, denied: deny.length }, "wrote restricted settings");
}

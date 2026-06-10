import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, EngineConfig } from "./types.js";
import { log } from "./logger.js";

const logger = log("agents");

interface AgentMeta {
  displayName?: string;
  model?: string;
  enabled?: boolean;
  slack?: { botUserId?: string };
  allowFrom?: string[];
  profile?: string;
}

interface SlackSecret {
  appToken?: string;
  botToken?: string;
  botUserId?: string;
}

/**
 * Load the agent roster from the TENANT layer. An agent is a directory under
 * tenant/agents/<id>/ containing at least its persona (CLAUDE.md). Optional
 * tenant/agents/<id>/agent.json carries metadata (displayName, model, enabled).
 * Its Slack identity (tokens) lives in tenant/secrets/slack/<id>.json, never in
 * the agent dir and never in git. Nothing about agents is hardcoded in the engine.
 */
export function loadAgents(cfg: EngineConfig): AgentDef[] {
  const dir = cfg.paths.agentsDir;
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const id = ent.name;
    const meta = readJson<AgentMeta>(join(dir, id, "agent.json")) ?? {};
    const secret = readJson<SlackSecret>(join(cfg.paths.secretsDir, "slack", `${id}.json`));
    out.push({
      id,
      displayName: meta.displayName ?? id,
      dir: join(dir, id),
      model: meta.model,
      enabled: meta.enabled !== false,
      slack: secret
        ? {
            appToken: secret.appToken,
            botToken: secret.botToken,
            botUserId: secret.botUserId ?? meta.slack?.botUserId,
          }
        : undefined,
      allowFrom: meta.allowFrom,
      profile: meta.profile,
    });
  }
  return out;
}

/** Agents that have a usable Slack identity (can ingest + reply). */
export function slackAgents(agents: AgentDef[]): AgentDef[] {
  return agents.filter((a) => a.enabled && a.slack?.appToken && a.slack?.botToken);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    logger.warn({ path, err }, "failed to parse agent json");
    return undefined;
  }
}

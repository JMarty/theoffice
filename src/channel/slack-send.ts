import { WebClient } from "@slack/web-api";
import type { EngineConfig } from "../types.js";
import { loadAgents } from "../agents.js";
import { listOutboundQueued, markOutboundFailed, markOutboundSent } from "../queue/index.js";
import { recordOutbound } from "../memory/conversation.js";
import { log } from "../logger.js";

const logger = log("slack-send");
const TICK_MS = 1500;

/**
 * Outbound sender: drains outbound_queue and posts each message AS the agent's
 * own bot (its name + avatar) via that agent's botToken. Durable + retriable +
 * logged. This is how "Charly" replies look like they came from Charly.
 *
 * (Agent replies reach this queue via the dashboard /api/outbound endpoint or the
 * `office-say` CLI — see Phase 5; the engine itself can also enqueue here.)
 */
export function startSlackSender(cfg: EngineConfig): () => void {
  const botTokens = new Map<string, string>();
  for (const a of loadAgents(cfg)) {
    if (a.slack?.botToken) botTokens.set(a.id, a.slack.botToken);
  }
  const webByAgent = new Map<string, WebClient>();
  const web = (agentId: string): WebClient | null => {
    const tok = botTokens.get(agentId);
    if (!tok) return null;
    let w = webByAgent.get(agentId);
    if (!w) {
      w = new WebClient(tok);
      webByAgent.set(agentId, w);
    }
    return w;
  };

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const item of listOutboundQueued()) {
      const w = web(item.agent_id);
      if (!w) {
        markOutboundFailed(item.id, "no bot token for agent");
        continue;
      }
      try {
        await w.chat.postMessage({ channel: item.channel, text: item.text });
        markOutboundSent(item.id);
        recordOutbound(item.agent_id, item.channel, item.text);
        logger.info({ id: item.id, agent: item.agent_id }, "outbound sent");
      } catch (err) {
        markOutboundFailed(item.id, String(err));
        logger.warn({ id: item.id, agent: item.agent_id, err }, "outbound failed (will retry)");
      }
    }
  };

  const handle = setInterval(() => void tick(), TICK_MS);
  logger.info({ agents: botTokens.size }, "slack sender started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

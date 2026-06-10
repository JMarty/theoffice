import { SocketModeClient } from "@slack/socket-mode";
import type { EngineConfig } from "../types.js";
import { loadAgents, slackAgents } from "../agents.js";
import { enqueueInbound } from "../queue/index.js";
import { isAllowedSender } from "./access.js";
import { log } from "../logger.js";

const logger = log("slack-ingest");

export interface ParsedInbound {
  text: string;
  channel: string;
  user: string;
  ts: string;
}

/**
 * Pure inbound parser (testable without Slack). Accepts only real human messages
 * — DMs or channel posts — and rejects anything from a bot (incl. the agent's own
 * echoes), edits, joins, and empty text.
 */
export function parseInbound(event: unknown, selfBotUserId?: string): ParsedInbound | null {
  const e = event as Record<string, unknown> | null;
  if (!e || e.type !== "message") return null;
  if (e.subtype) return null; // message_changed / bot_message / channel_join / ...
  if (e.bot_id) return null; // any bot, including self
  if (selfBotUserId && e.user === selfBotUserId) return null;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  if (!text) return null;
  if (typeof e.channel !== "string" || typeof e.user !== "string" || typeof e.ts !== "string") return null;
  return { text, channel: e.channel, user: e.user, ts: e.ts };
}

/**
 * Start the Slack ingest daemon: ONE Socket-Mode connection per slack-enabled
 * agent-app. Each connection is the sole consumer of its app's events (no
 * event-splitting). Inbound human messages are enqueued to the single inbound
 * queue with a Slack-ts dedup key, then drained by the Session Manager deliverer.
 */
export function startSlackIngest(cfg: EngineConfig): () => void {
  const agents = slackAgents(loadAgents(cfg));
  if (agents.length === 0) {
    logger.info("no slack-enabled agents — ingest idle");
    return () => {};
  }

  const ownerId = cfg.owner.slackUserId;
  const clients: SocketModeClient[] = [];
  for (const agent of agents) {
    const sm = new SocketModeClient({ appToken: agent.slack!.appToken! });

    sm.on("message", async (args: { ack?: () => Promise<void>; event?: unknown; body?: { event?: unknown } }) => {
      if (args.ack) {
        try {
          await args.ack();
        } catch {
          /* ack best-effort */
        }
      }
      const event = args.event ?? args.body?.event;
      const parsed = parseInbound(event, agent.slack!.botUserId);
      if (!parsed) return;
      if (!isAllowedSender(parsed.user, agent.allowFrom, ownerId)) {
        logger.warn({ agent: agent.id, from: parsed.user }, "ignored DM from non-allowed user");
        return;
      }
      const id = enqueueInbound({
        agentId: agent.id,
        source: "channel",
        prompt: parsed.text,
        replyChannel: parsed.channel,
        replyUser: parsed.user,
        dedupKey: `slack:${parsed.ts}`,
      });
      logger.info({ agent: agent.id, enqueued: id != null }, "inbound DM enqueued");
    });

    sm.start().catch((err: unknown) => logger.error({ agent: agent.id, err }, "socket start failed"));
    clients.push(sm);
    logger.info({ agent: agent.id, name: agent.displayName }, "slack ingest socket up");
  }

  return () => {
    for (const c of clients) c.disconnect().catch(() => {});
  };
}

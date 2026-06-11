import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import type { EngineConfig } from "../types.js";
import { loadAgents, slackAgents } from "../agents.js";
import { enqueueInbound } from "../queue/index.js";
import { isAllowedSender } from "./access.js";
import { downloadFiles } from "./files.js";
import { log } from "../logger.js";

const logger = log("slack-ingest");

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload?: string;
}

export interface ParsedInbound {
  text: string;
  channel: string;
  user: string;
  ts: string;
  files: SlackFile[];
}

function parseFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const dl =
      typeof o.url_private_download === "string"
        ? o.url_private_download
        : typeof o.url_private === "string"
          ? o.url_private
          : undefined;
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : id,
      mimetype: typeof o.mimetype === "string" ? o.mimetype : "application/octet-stream",
      urlPrivateDownload: dl,
    });
  }
  return out;
}

/**
 * Pure inbound parser (testable without Slack). Accepts real human messages —
 * DMs or channel posts, including ones that carry file attachments (subtype
 * "file_share") — and rejects anything from a bot (incl. the agent's own echoes),
 * edits, joins, and messages with neither text nor files.
 */
export function parseInbound(event: unknown, selfBotUserId?: string): ParsedInbound | null {
  const e = event as Record<string, unknown> | null;
  if (!e || e.type !== "message") return null;
  // allow plain messages and file uploads; reject edits / bot_message / joins / ...
  if (e.subtype && e.subtype !== "file_share") return null;
  if (e.bot_id) return null; // any bot, including self
  if (selfBotUserId && e.user === selfBotUserId) return null;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  const files = parseFiles(e.files);
  if (!text && files.length === 0) return null;
  if (typeof e.channel !== "string" || typeof e.user !== "string" || typeof e.ts !== "string") return null;
  return { text, channel: e.channel, user: e.user, ts: e.ts, files };
}

/**
 * Build the prompt delivered to the agent's session. When files were attached we
 * download them to the agent's inbox and point the agent at the local paths so it
 * can open them with the Read tool (images + PDFs). Failed downloads (e.g. the bot
 * lacks files:read) are surfaced to the agent rather than dropped silently.
 */
async function buildPrompt(parsed: ParsedInbound, agentDir: string, botToken: string): Promise<string> {
  if (parsed.files.length === 0) return parsed.text;
  const inbox = join(agentDir, "inbox");
  const dl = await downloadFiles(parsed.files, botToken, inbox, parsed.ts.replace(/\./g, "_"));
  const got = dl.filter((f) => f.ok);
  const failed = dl.filter((f) => !f.ok);
  const lines: string[] = [];
  if (got.length) {
    lines.push(`[The user attached ${got.length} file(s). Open them with the Read tool:`);
    for (const f of got) lines.push(`- ${f.path} (${f.mimetype})`);
    lines.push("]");
  }
  if (failed.length) {
    lines.push(
      `[${failed.length} attached file(s) could NOT be downloaded — the bot is likely missing the Slack files:read scope: ${failed
        .map((f) => f.name)
        .join(", ")}. Tell the user you can't open attachments until that scope is added.]`
    );
  }
  const block = lines.join("\n");
  return parsed.text ? `${parsed.text}\n\n${block}` : block;
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
      const prompt = await buildPrompt(parsed, agent.dir, agent.slack!.botToken!);
      const id = enqueueInbound({
        agentId: agent.id,
        source: "channel",
        prompt,
        replyChannel: parsed.channel,
        replyUser: parsed.user,
        dedupKey: `slack:${parsed.ts}`,
      });
      logger.info(
        { agent: agent.id, enqueued: id != null, files: parsed.files.length },
        "inbound DM enqueued"
      );
    });

    sm.start().catch((err: unknown) => logger.error({ agent: agent.id, err }, "socket start failed"));
    clients.push(sm);
    logger.info({ agent: agent.id, name: agent.displayName }, "slack ingest socket up");
  }

  return () => {
    for (const c of clients) c.disconnect().catch(() => {});
  };
}

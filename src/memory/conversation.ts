import { getDb } from "../db/index.js";

/** Append-only conversation log (mirrors v1 conversation_log). */

export function recordInbound(agentId: string, channelId: string | null, text: string, messageId?: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO conversation_log (agent_id, channel_id, direction, message_id, text)
       VALUES (?, ?, 'in', ?, ?)`
    )
    .run(agentId, channelId, messageId ?? null, text);
}

export function recordOutbound(agentId: string, channelId: string | null, text: string, messageId?: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO conversation_log (agent_id, channel_id, direction, message_id, text)
       VALUES (?, ?, 'out', ?, ?)`
    )
    .run(agentId, channelId, messageId ?? null, text);
}

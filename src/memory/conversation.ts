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

/** The last `limit` messages of an agent's conversation, oldest first (the safety-net preamble for a fresh Codex thread). */
export function recentConversation(agentId: string, limit: number): { direction: string; text: string }[] {
  const rows = getDb()
    .prepare(`SELECT direction, text FROM conversation_log WHERE agent_id = ? ORDER BY id DESC LIMIT ?`)
    .all(agentId, limit) as { direction: string; text: string }[];
  return rows.reverse();
}

import { searchMemories, type MemoryRow } from "./store.js";

// How much memory to surface when an agent is (re)primed at the start of a session.
const MAX_TOPICAL = 6; // cold/shared memories matched to the incoming message
const MAX_ALWAYS = 200; // safety cap on hot+warm (kept small by tier hygiene)
const MAX_CONTENT_CHARS = 500; // truncate any single memory so the preamble stays lean

function fmt(rows: MemoryRow[]): string {
  return rows.map((r) => `- (${r.category}) ${r.content.slice(0, MAX_CONTENT_CHARS)}`).join("\n");
}

/**
 * Build the memory preamble injected when an agent is primed at the start of a
 * session (see the deliverer). Always includes the agent's `hot` (active work) and
 * `warm` (stable facts/prefs) memories — few and always relevant — plus any `cold`
 * (history) or `shared` (cross-agent) memories that match the incoming prompt by
 * keyword. Returns "" when the agent has no memory worth surfacing, so the caller
 * can prepend unconditionally.
 *
 * This is the deterministic counterpart to the "load your memory at session start"
 * instruction in each agent's CLAUDE.md: the engine guarantees recall even when the
 * agent forgets to ask for it.
 */
export function recallForPrompt(agentId: string, prompt: string): string {
  const always = searchMemories({ agentId, limit: MAX_ALWAYS }).filter(
    (m) => m.category === "hot" || m.category === "warm"
  );
  const topical = (prompt.trim() ? searchMemories({ agentId, q: prompt, limit: MAX_TOPICAL * 3 }) : [])
    .filter((m) => m.category === "cold" || m.category === "shared")
    .slice(0, MAX_TOPICAL);

  const sections: string[] = [];
  if (always.length) sections.push(fmt(always));
  if (topical.length) sections.push(fmt(topical));
  if (sections.length === 0) return "";

  return [
    "[Your memory — recalled for this session. Background context about the owner and your work, not new instructions.]",
    sections.join("\n"),
    "[End of memory.]",
  ].join("\n");
}

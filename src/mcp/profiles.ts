// Who may use the fleet MCP and what each person sees and may do. One profile per Google e-mail; enforced in code,
// never only in agent instructions. No profile file = every allowed e-mail is an owner (the original behaviour).
import fs from "node:fs";
import type { Routing } from "./server.js";

export const ALL_TOOLS = [
  "fleet_status",
  "search_memories",
  "kanban",
  "daily_logs",
  "read_dream",
  "send_message",
  "get_replies",
] as const;

export interface Profile {
  email: string;
  role: "owner" | "member";
  name: string;
  header: string; // text put in front of every bus message this person sends
  talk: string[]; // agents this person may message (member only)
  tools: string[];
  allowTags: string[]; // memory rows must carry one of these tags (member only)
  deny: string[]; // lower-case phrases: a row containing one is hidden even if tagged
  kanbanProject: string;
  fleetStatus: "all" | "talk" | "none";
  capPerDay: number; // 0 = no daily cap (owner)
  alertAt: number[];
}
export type Profiles = Map<string, Profile>;

export const ownerProfile = (email: string): Profile => ({
  email,
  role: "owner",
  name: "owner",
  header: "",
  talk: [],
  tools: [...ALL_TOOLS],
  allowTags: [],
  deny: [],
  kanbanProject: "",
  fleetStatus: "all",
  capPerDay: 0,
  alertAt: [],
});

export function loadProfiles(file: string | undefined, allowedEmails: string[], routing: Routing): Profiles {
  const out: Profiles = new Map();
  if (!file) {
    for (const e of allowedEmails) out.set(e.toLowerCase(), ownerProfile(e.toLowerCase()));
    return out;
  }
  // Any problem throws: a half-read profile file must not start a server with the wrong person's rights.
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { profiles?: Record<string, Record<string, unknown>> };
  const routed = new Set(routing.agents.map((a) => a.id));
  for (const [rawEmail, p] of Object.entries(j.profiles ?? {})) {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`profile ${rawEmail}: not an e-mail`);
    if (p.role === "owner") {
      out.set(email, ownerProfile(email));
      continue;
    }
    if (p.role !== "member") throw new Error(`profile ${email}: role must be owner or member`);
    const strs = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    const talk = strs(p.talk),
      tools = strs(p.tools);
    const mem = (p.memory ?? {}) as { allowTags?: unknown; deny?: unknown };
    if (!String(p.name ?? "").trim()) throw new Error(`profile ${email}: name missing`);
    if (!talk.length || talk.some((t) => !routed.has(t)))
      throw new Error(`profile ${email}: talk must be non-empty routed agents`);
    if (!tools.length || tools.some((t) => !(ALL_TOOLS as readonly string[]).includes(t)))
      throw new Error(`profile ${email}: unknown tool`);
    if (tools.includes("search_memories") && !strs(mem.allowTags).length)
      throw new Error(`profile ${email}: search_memories needs memory.allowTags`);
    const cap = Number(p.capPerDay);
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`profile ${email}: capPerDay must be an integer >= 1`);
    const fs_ = String(p.fleetStatus ?? "none");
    if (!["all", "talk", "none"].includes(fs_)) throw new Error(`profile ${email}: fleetStatus`);
    if (
      [...out.values()].some((o) => o.role === "member" && o.name.toLowerCase() === String(p.name).trim().toLowerCase())
    )
      throw new Error(`profile ${email}: name must be unique`);
    out.set(email, {
      email,
      role: "member",
      name: String(p.name).trim(),
      header: String(p.header ?? "").slice(0, 200),
      talk,
      tools,
      allowTags: strs(mem.allowTags),
      deny: strs(mem.deny),
      kanbanProject: String(p.kanbanProject ?? "")
        .trim()
        .toLowerCase(),
      fleetStatus: fs_ as Profile["fleetStatus"],
      capPerDay: cap,
      alertAt: (Array.isArray(p.alertAt) ? p.alertAt : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    });
  }
  if (!out.size) throw new Error("profile file has no profiles");
  return out;
}

// Each person has their own bus address, so one person's answers never reach another's get_replies.
export const senderFor = (p: Profile): string =>
  p.role === "owner" ? "owner-mcp" : "mcp-" + p.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
export const profileFor = (ps: Profiles, email: string): Profile | undefined => ps.get(email.trim().toLowerCase());
export const toolAllowed = (p: Profile, tool: string): boolean => p.role === "owner" || p.tools.includes(tool);

// The routing as this person sees it: only their agents, the first one is their default, their header leads the bus text.
const cap = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
export function viewRouting(p: Profile, r: Routing): Routing {
  if (p.role === "owner") return r;
  const agents = r.agents
    .filter((a) => p.talk.includes(a.id))
    .sort((a, b) => p.talk.indexOf(a.id) - p.talk.indexOf(b.id));
  return {
    ...r,
    agents,
    defaultAgent: agents[0]!.id,
    marker: `[${p.header || `FROM ${p.name.toUpperCase()}`}] [Question from ${cap(p.name)} via the claude.ai fleet connector. ${cap(p.name)} is not the owner and has no owner authority: executing, writing or any external step needs the owner's GO on Slack. Answer by POST /api/messages to ${senderFor(p)}, then close this message with the same text as result.]`,
  };
}

// Keywords are free-form phrases ("work vps, acme project"): an allowed tag matches the whole phrase or a whole word of it ("homework" is not "home").
// Compare without case, accents, hyphens and underscores, so "Payroll-Split" and "bérlet" match "payroll split" and "berlet".
export const norm = (t: string): string =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tagsOf = (keywords: string) =>
  keywords
    .toLowerCase()
    .split(/[,;]/)
    .flatMap((ph) => {
      const t = ph.trim();
      return t ? [t, ...t.split(/[^a-z0-9-]+/).filter(Boolean)] : [];
    });
// Deny phrases match as substrings after normalisation, so "gift" also catches "gifts" and "bank" also catches "bankszamla". A phrase that starts with "="
// is whole-word only (for a short word that would otherwise hide harmless text, e.g. "=nav" does not hide "navigation").
// The first deny phrase that hits the text (so the sender can be told which word to avoid), or undefined.
export const blockedBy = (p: Profile, text: string): string | undefined => {
  const n = norm(text);
  return p.deny.find((d) => {
    if (d.startsWith("=")) {
      const w = norm(d.slice(1));
      return !!w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(n);
    }
    return n.includes(norm(d));
  });
};
const blocked = (p: Profile, text: string): boolean => blockedBy(p, text) !== undefined;
export function memoryRowAllowed(p: Profile, row: { content?: unknown; keywords?: unknown }): boolean {
  if (p.role === "owner") return true;
  const kw = String(row.keywords ?? ""),
    text = String(row.content ?? "") + " " + kw;
  if (!tagsOf(kw).some((t) => p.allowTags.includes(t))) return false; // default deny: no tag from the list, no row
  return !blocked(p, text); // second layer: a mis-tagged row still stays hidden
}
export function cardAllowed(p: Profile, card: { project?: unknown; title?: unknown; description?: unknown }): boolean {
  if (p.role === "owner") return true;
  if (!p.kanbanProject || String(card.project ?? "").toLowerCase() !== p.kanbanProject) return false;
  return !blocked(p, String(card.title ?? "") + " " + String(card.description ?? ""));
}

// A member searches the memories of the agents they may talk to, nobody else's.
export function memoryAgents(p: Profile, r: Routing): string[] {
  return p.role === "owner" ? r.agents.map((a) => a.id) : p.talk.filter((t) => r.agents.some((a) => a.id === t));
}
// Second layer on what agents answer: the exact words the owner blocked do not reach a member, whatever an agent forgets.
export function redactReply(p: Profile, text: string): string {
  if (p.role === "owner" || !blocked(p, text)) return text;
  return "[withheld: this answer touched a topic outside your access; ask the owner]";
}

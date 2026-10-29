import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { EXPECTED_DIM } from "./embeddings.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, searchMemories, searchMemoriesHybrid } from "./store.js";
import { encodeEmbedding } from "./embeddings.js";

/**
 * The ON-DEMAND search path, GET /api/memories?q=.
 *
 * This is the one agents call when they go looking for something. It must understand meaning, like the
 * automatic recall slice, and not be keyword-only.
 */
let dir: string;
const V = (s: number) => Array.from({ length: EXPECTED_DIM }, (_, i) => (Math.floor(i / (EXPECTED_DIM / 8)) === s % 8 ? 1 : 0));
const noEmbedder = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no embedder"); }));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-hybrid-"));
  openDb(join(dir, "test.db"));
  noEmbedder(); // keep saveMemory's fire-and-forget from overwriting the seeded vectors
  const id = saveMemory({ agentId: "h", content: "the relocation undertaking before an auditor", category: "cold" });
  getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeEmbedding(V(2)), id);
  saveMemory({ agentId: "h", content: "invoice INV-0001 for the catalog", category: "cold" });
});
afterAll(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
afterEach(noEmbedder);

describe("searchMemoriesHybrid", () => {
  it("finds by MEANING when the words do not match at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(2) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "obligation", limit: 5 });
    expect(rows.some((r) => r.content.includes("relocation undertaking"))).toBe(true);
  });

  it("still finds an exact string vectors are bad at, like an invoice number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(7) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "INV-0001", limit: 5 });
    expect(rows.some((r) => r.content.includes("INV-0001"))).toBe(true);
  });

  it("embedder down -> exactly the keyword result, never an error", async () => {
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "invoice", limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(searchMemories({ agentId: "h", q: "invoice", limit: 5 }).map((r) => r.id));
  });

  it("REGRESSION: vector hits must not crowd out an exact-string keyword hit", async () => {
    // With vector hits concatenated BEFORE keyword hits, a query for invoice INV-0001 could return 8
    // rows, none of them the row containing that string, because the vector side filled every slot
    // first. Keyword results get a guaranteed share.
    for (let i = 0; i < 20; i++) {
      const id = saveMemory({ agentId: "h", content: `padding memory ${i} about project matters`, category: "cold" });
      getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeEmbedding(V(2)), id);
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(2) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "INV-0001", limit: 8 });
    expect(rows.some((r) => r.content.includes("INV-0001"))).toBe(true);
  });

  it("respects the limit and never duplicates a row across both paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(2) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "relocation", limit: 2 });
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

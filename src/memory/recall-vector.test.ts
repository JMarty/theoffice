import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { EXPECTED_DIM } from "./embeddings.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, searchMemoriesByVector } from "./store.js";
import { recallForPrompt, recallForPromptAsync, PREAMBLE_MAX_CHARS } from "./recall.js";
import { encodeEmbedding } from "./embeddings.js";

/**
 * Hybrid recall: vector search combined with FTS keyword search.
 *
 * WHY IT IS NEEDED: ftsQuery OR-joins every token including stopwords ("my", "is", "the", "how"), so
 * almost every row matches and the ORDER BY created_at DESC then just returns the newest one. Keyword
 * topical recall alone can therefore return the same irrelevant memory for unrelated queries. Vectors
 * rank the relevant memory first.
 *
 * SAFETY PROPERTY, non-negotiable: this runs on the session-start prime path, which is pane-injected
 * through send-keys. If the embedder is slow or down, recall must degrade to exactly today's FTS
 * behaviour rather than delay or fail a delivery.
 */

let dir: string;
// Orthogonal by construction: each seed lights a distinct 96-wide band, so cos(V(a),V(b)) is 1 when
// a===b and 0 otherwise. A smooth function like Math.sin(seed + i*0.001) looks different but is highly
// correlated across seeds, which silently makes a discrimination test pass for the wrong reason.
const V = (seed: number) => Array.from({ length: EXPECTED_DIM }, (_, i) => (Math.floor(i / (EXPECTED_DIM / 8)) === seed % 8 ? 1 : 0));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-recallvec-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
// saveMemory can FIRE the embedder (fire-and-forget). Left alone, that async write lands LATER and
// could overwrite the deterministic vectors these tests seed, so assertions would pass or fail on a
// race. Keep fetch failing by default for the whole file: the fire-and-forget then writes nothing,
// seeded vectors stand, and any test that wants a response stubs its own.
const noEmbedder = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no embedder in tests"); }));
beforeAll(noEmbedder);
afterEach(noEmbedder);

function seed(content: string, category: "hot" | "warm" | "cold" | "shared", vec?: number[], agent = "v") {
  const id = saveMemory({ agentId: agent, content, category });
  if (vec) getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeEmbedding(vec), id);
  return id;
}

describe("searchMemoriesByVector", () => {
  beforeAll(() => {
    seed("the service agreement joint liability clause", "cold", V(1));
    seed("completely unrelated stationery note", "cold", V(900));
    seed("a cold memory with no vector at all", "cold");
  });

  it("ranks by meaning and excludes anything below the floor", () => {
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold", "shared"], queryVector: V(1), limit: 5, floor: 0.9 });
    expect(hits[0]!.content).toContain("joint liability");
    expect(hits.some((h) => h.content.includes("stationery"))).toBe(false);
  });

  it("rows with no vector are simply absent, never a crash", () => {
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold"], queryVector: V(1), limit: 50, floor: -1 });
    expect(hits.some((h) => h.content.includes("no vector at all"))).toBe(false);
  });

  it("a stored WRONG-LENGTH vector scores 0 and cannot crash the ranking ", () => {
    // decodeEmbedding is a pure parser by design, so a short vector reaches the ranker. Every consumer
    // must go through cosineSimilarity, which returns 0 on a length mismatch rather than raw-indexing.
    const id = seed("row carrying a legacy 3-element vector", "cold");
    getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify([1, 2, 3]), id);
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold"], queryVector: V(1), limit: 50, floor: 0.5 });
    expect(hits.some((h) => h.content.includes("legacy 3-element"))).toBe(false);
  });
});

describe("recallForPrompt — vectors are additive, never a regression", () => {
  beforeAll(() => {
    seed("ACTIVE: chase the contract signature", "hot");
    seed("STABLE: user prefers short replies", "warm");
  });

  it("without a query vector it behaves exactly as before (FTS only)", () => {
    const a = recallForPrompt("v", "contract");
    const b = recallForPrompt("v", "contract", undefined);
    expect(a).toBe(b);
    expect(a).toContain("chase the contract signature");
  });

  it("with a query vector it surfaces a semantic match that shares NO keywords", () => {
    // "relocation" appears nowhere in the stored text, so FTS cannot reach it.
    const out = recallForPrompt("v", "relocation", V(1));
    expect(out).toContain("joint liability");
  });

  it("hot and warm still lead and are never displaced by topical hits", () => {
    const out = recallForPrompt("v", "relocation", V(1));
    expect(out.indexOf("chase the contract signature")).toBeLessThan(out.indexOf("joint liability"));
    expect(out.indexOf("user prefers short replies")).toBeLessThan(out.indexOf("joint liability"));
  });

  it("never exceeds the preamble budget", () => {
    expect(recallForPrompt("v", "relocation", V(1)).length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS + 200);
  });
});

describe("recallForPromptAsync — the embedder can never block a delivery", () => {
  it("embedder down -> identical output to the FTS-only path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await recallForPromptAsync("v", "contract")).toBe(recallForPrompt("v", "contract"));
  });

  it("embedder hanging -> returns within the timeout, still with the FTS answer", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const t0 = Date.now();
    const out = await recallForPromptAsync("v", "contract", 300);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out).toBe(recallForPrompt("v", "contract"));
  });

  it("embedder healthy -> the semantic hit appears", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(1) }) })));
    expect(await recallForPromptAsync("v", "relocation")).toContain("joint liability");
  });
});

describe("topical must not be starved by a large hot/warm bundle", () => {
  it("a semantic hit still appears when hot+warm alone exceed the whole budget", () => {
    // An agent can have a few dozen hot and hundreds of warm memories, far above the char budget.
    // Under strict hot -> warm -> topical priority the loop breaks long before topical, so vector
    // search would be correct and STRUCTURALLY UNREACHABLE. Topical keeps a reserved share.
    for (let i = 0; i < 60; i++) seed(`WARM FILLER ${i} ` + "x".repeat(400), "warm");
    seed("the onboarding and audit undertaking", "cold", V(3));
    const out = recallForPrompt("v", "relocation", V(3));
    expect(out).toContain("onboarding and audit undertaking");
    expect(out.length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS + 200);
  });
});

describe("every tier gets a guaranteed slice, none starves another", () => {
  it("long hot memories cannot push warm out of the preamble entirely", () => {
    // Hot entries are long, and strict priority could let them eat the whole non-topical budget. Warm
    // is the stable-facts tier (preferences, config, project context), so losing it entirely is a
    // correctness problem, not a cosmetic one.
    for (let i = 0; i < 12; i++) seed(`HOT LONG ${i} ` + "h".repeat(480), "hot", undefined, "v2");
    for (let i = 0; i < 12; i++) seed(`WARM FACT ${i} user preference number ${i}`, "warm", undefined, "v2");
    const out = recallForPrompt("v2", "anything");
    expect(out).toContain("HOT LONG");
    expect(out).toContain("WARM FACT");
  });
});

describe("keyword hits get reserved slots INSIDE topical", () => {
  it("saturated vector hits cannot zero out keyword-only matches", () => {
    // The byte budget has reserves; the topical RESULT-SET assembly needs one too. Vectors push first
    // up to MAX_TOPICAL, so once they saturate, the keyword search would contribute nothing, and
    // keyword-only matches are exactly the exact-string ids and invoice numbers keywords exist for.
    for (let i = 0; i < 8; i++) seed(`semantically adjacent filler ${i}`, "cold", V(5), "v3");
    seed("INV-0002 exact invoice reference", "cold", V(6), "v3"); // vector-far, keyword-near
    const out = recallForPrompt("v3", "INV-0002", V(5));
    expect(out).toContain("INV-0002");
  });
});

describe("the documented cap covers the WHOLE preamble, frame included", () => {
  it("total output never exceeds PREAMBLE_MAX_CHARS", () => {
    // The constant is documented as "Hard cap on the WHOLE preamble", so the header, footer and the
    // "N more" line must be counted too.
    for (let i = 0; i < 40; i++) seed(`BULK ${i} ` + "z".repeat(460), "warm", undefined, "v4");
    for (let i = 0; i < 10; i++) seed(`BULK HOT ${i} ` + "z".repeat(460), "hot", undefined, "v4");
    expect(recallForPrompt("v4", "anything").length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS);
  });
});

describe("CORE facts are always known, never competing for scraps", () => {
  it("a high-salience fact loads even when hundreds of ordinary memories exist", () => {
    for (let i = 0; i < 60; i++) seed(`ordinary warm ${i} ` + "w".repeat(430), "warm", undefined, "v5");
    for (let i = 0; i < 10; i++) seed(`ordinary hot ${i} ` + "h".repeat(430), "hot", undefined, "v5");
    const id = seed("CORE FACT: the office has 3 printers and is open daily", "warm", undefined, "v5");
    getDb().prepare("UPDATE memories SET salience = 5.0 WHERE id = ?").run(id);
    const out = recallForPrompt("v5", "hello there");
    // The point of a core tier: the user should never have to answer "how many printers" twice, so this
    // fact must load on EVERY wake regardless of how much else has accumulated. Salience-ordering alone
    // is not enough: a core fact can miss the warm slice by a small margin.
    expect(out).toContain("CORE FACT");
  });
});

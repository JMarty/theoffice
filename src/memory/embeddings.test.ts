import { describe, it, expect, vi, afterEach } from "vitest";
import { cosineSimilarity, encodeEmbedding, decodeEmbedding, generateEmbedding, EXPECTED_DIM } from "./embeddings.js";

/**
 * Memory vectors.
 *
 * Context: the `embedding` column can stay empty while recall still works on FTS keywords, so nothing
 * looks broken, yet recall cannot match by MEANING ("the office" never finds a memory that only says
 * "the Main Street unit").
 *
 * The load-bearing rule here: EMBEDDING FAILURE MUST NEVER COST A MEMORY. Ollama is a local service
 * that can be down, slow, or mid-restart. Saving the memory is the thing that matters; the vector is an
 * enhancement that can be backfilled later. So every function in this module degrades to null/0 rather
 * than throwing.
 */

afterEach(() => vi.unstubAllGlobals());

describe("cosineSimilarity", () => {
  it("identical vectors -> 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("orthogonal vectors -> 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("opposite vectors -> -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("scale does not matter, only direction", () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  it("mismatched lengths -> 0, never a throw or a NaN", () => {
    // A model change can silently alter the dimension. Ranking must degrade, not crash the recall path.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("zero or empty vectors -> 0, never a divide-by-zero NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("encode / decode", () => {
  it("round-trips a vector through the TEXT column", () => {
    const v = [0.0125, -0.9, 3];
    expect(decodeEmbedding(encodeEmbedding(v))).toEqual(v);
  });

  it("decodes junk to null instead of throwing", () => {
    // The column is TEXT and may hold rows written by older code. A single bad row must not take
    // down a search over thousands of memories.
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding("")).toBeNull();
    expect(decodeEmbedding("not json")).toBeNull();
    expect(decodeEmbedding('{"nope":1}')).toBeNull();
    expect(decodeEmbedding("[1,\"two\",3]")).toBeNull();
  });
});

describe("generateEmbedding — degrades, never throws", () => {
  it("returns the vector Ollama gives back", async () => {
    const v = Array.from({ length: EXPECTED_DIM }, (_, i) => i / EXPECTED_DIM);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: v }) })));
    expect(await generateEmbedding("hello")).toEqual(v);
  });

  it("Ollama down (fetch throws) -> null, no exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("non-OK response -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("malformed body -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: "not-an-array" }) })));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("empty input is not sent to the model at all", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await generateEmbedding("   ")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("REJECTS a wrong-dimension vector instead of banking a dead one", async () => {
    // A half-loaded or momentarily-wrong Ollama model returns a short vector; stored, it reads cosine 0
    // against every full-length vector, so it is SEMANTICALLY DEAD. Worse, it is not null, so
    // countEmbeddings scores the row as covered and the backfill (WHERE embedding IS NULL) never retries
    // it. Rejecting keeps the row NULL, which is honest and self-healing: the next backfill pass picks
    // it up.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [1, 2, 3] }) })));
    expect(await generateEmbedding("short vector from a broken model")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: Array(767).fill(0.1) }) })));
    expect(await generateEmbedding("off-by-one dimension")).toBeNull();
  });

  it("accepts the expected number of dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: Array(EXPECTED_DIM).fill(0.1) }) })));
    expect(await generateEmbedding("good")).toHaveLength(EXPECTED_DIM);
  });

  it("truncates very long content before sending", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ embedding: Array(EXPECTED_DIM).fill(0.1) }) }));
    vi.stubGlobal("fetch", f);
    await generateEmbedding("x".repeat(9000));
    const body = JSON.parse((f.mock.calls[0]![1] as { body: string }).body);
    expect(body.prompt.length).toBeLessThanOrEqual(2000);
  });
});

/**
 * The save path is deliberately fire-and-forget: generateEmbedding returns null on timeout, the row
 * keeps its NULL, and nothing retries or alarms. That is the right trade for a save (the memory is the
 * asset, the vector is an enhancement) but it means the timeout must be generous enough that a cold
 * model load fits. Recall is unaffected either way: it races on its own RECALL_EMBED_TIMEOUT_MS and
 * never waits on this one.
 */
describe("EMBED_TIMEOUT_MS — must tolerate a cold model load", () => {
  it("defaults high enough for a cold model load", async () => {
    vi.resetModules();
    delete process.env.EMBED_TIMEOUT_MS;
    const m = await import("./embeddings.js?fresh-default");
    expect(m.EMBED_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("is env-overridable, so an operator can tune it without a rebuild", async () => {
    vi.resetModules();
    process.env.EMBED_TIMEOUT_MS = "12345";
    const m = await import("./embeddings.js?fresh-override");
    expect(m.EMBED_TIMEOUT_MS).toBe(12345);
    delete process.env.EMBED_TIMEOUT_MS;
  });
});

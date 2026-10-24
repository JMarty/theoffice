import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SEP = "─".repeat(40), FOOTER = "  bypass permissions on (shift+tab to cycle)";
const STUCK = ["earlier output", SEP, "❯ [Pasted text #1 +4 lines]", SEP, FOOTER].join("\n");
const CLEAN = ["earlier output", SEP, "❯ ", SEP, FOOTER].join("\n");
const state = { pane: STUCK as string | null, keys: [] as string[] };

vi.mock("./tmux.js", () => ({
  listSessions: () => ["agent-toby"],
  capturePane: () => state.pane,
  sendKey: (_s: string, _n: string, k: string) => { state.keys.push(k); return true; },
}));
vi.mock("../queue/index.js", () => ({ reapStaleScheduler: () => 0, enqueueOutbound: () => {}, listOwnerAlarmable: () => [], markOwnerAlarmed: () => {} }));

import { startSessionHygiene } from "./modal-sweeper.js";

const cfg = { tmux: { socket: "s" }, owner: { slackUserId: "U" }, mainAgentId: "main" } as never;

describe("session-hygiene: a stuck pending paste gets its Enter", () => {
  beforeEach(() => { vi.useFakeTimers(); state.pane = STUCK; state.keys = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("presses Enter only after the placeholder is seen on consecutive ticks, then keeps pressing (bounded) while it stays", async () => {
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.keys).toEqual([]);                       // first sighting: a delivery may still be pressing its own Enter
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.keys).toEqual(["Enter"]);                // second consecutive sighting
    await vi.advanceTimersByTimeAsync(20_000 * 20);
    expect(state.keys.length).toBe(6);                    // bounded per episode
    stop();
  });

  it("stops as soon as the pane is clean, and a later jam starts a fresh count", async () => {
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(state.keys).toEqual(["Enter"]);
    state.pane = CLEAN;
    await vi.advanceTimersByTimeAsync(20_000 * 5);
    expect(state.keys).toEqual(["Enter"]);                // nothing more once it submitted
    state.pane = STUCK;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.keys).toEqual(["Enter"]);                // fresh episode: one sighting is not enough
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.keys).toEqual(["Enter", "Enter"]);
    stop();
  });

  it("never touches a busy pane or one that only quotes the placeholder", async () => {
    const stop = startSessionHygiene(cfg);
    state.pane = ["✻ Thinking… (12s · ↓ 1.2k tokens)", SEP, "❯ [Pasted text #1 +4 lines]", SEP, FOOTER].join("\n");
    await vi.advanceTimersByTimeAsync(20_000 * 6);
    state.pane = ["the tool printed: [Pasted text #1 +4 lines]", SEP, "❯ ", SEP, FOOTER].join("\n");
    await vi.advanceTimersByTimeAsync(20_000 * 6);
    expect(state.keys).toEqual([]);
    stop();
  });
});

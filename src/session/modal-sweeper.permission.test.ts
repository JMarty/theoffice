import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PROMPT = ["● Bash(rm -rf /tmp/x)", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again for rm commands", "   3. No, and tell Claude what to do differently (esc)"].join("\n");
const state = { sessions: ["agent-toby"], pane: PROMPT as string | null, keys: [] as string[], bus: [] as Array<[string, string, string]>, outbound: [] as unknown[], busFails: false };

vi.mock("./tmux.js", () => ({ listSessions: () => state.sessions, capturePane: () => state.pane, sendKey: (_s: string, _n: string, k: string) => { state.keys.push(k); return true; } }));
vi.mock("../queue/index.js", () => ({ reapStaleScheduler: () => 0, enqueueOutbound: (...a: unknown[]) => { state.outbound.push(a); }, listOwnerAlarmable: () => [], markOwnerAlarmed: () => {} }));
vi.mock("../bus/index.js", () => ({ sendAgentMessage: (f: string, t: string, c: string) => { if (state.busFails) throw new Error("db locked"); state.bus.push([f, t, c]); return 1; } }));

import { startSessionHygiene } from "./modal-sweeper.js";

const cfg = { tmux: { socket: "s" }, owner: { slackUserId: "U" }, mainAgentId: "main" } as never;

describe("session-hygiene: an approval prompt goes to the decider on the bus, never to the owner (owner rule 2026-11-02)", () => {
  beforeEach(() => { vi.useFakeTimers(); state.sessions = ["agent-toby"]; state.pane = PROMPT; state.keys = []; state.bus = []; state.outbound = []; state.busFails = false; });
  afterEach(() => { vi.useRealTimers(); });

  it("a frozen toby: ONE bus message to marveen with the captured prompt text, nothing to the owner's Slack, no keystroke", async () => {
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.bus).toHaveLength(1);
    const [from, to, text] = state.bus[0];
    expect([from, to]).toEqual(["session-hygiene", "marveen"]);
    expect(text).toContain("PERMISSION PROMPT: toby");
    expect(text).toContain("rm -rf /tmp/x"); expect(text).toContain("Do you want to proceed?");   // the captured prompt, so the decider can judge it
    expect(text).toContain("You decide, not the owner");
    expect(state.outbound).toEqual([]);                    // the owner's Slack gets nothing
    expect(state.keys).toEqual([]);                        // never a keystroke: a blind Enter would approve
    stop();
  });

  it("a frozen marveen cannot decide for itself: the message goes to darryl", async () => {
    state.sessions = ["agent-marveen"];
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.bus.map((b) => b[1])).toEqual(["darryl"]);
    expect(state.outbound).toEqual([]);
    stop();
  });

  it("re-alarms the same frozen prompt at most every 30 minutes, not every tick", async () => {
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000 * 30);        // 10 minutes
    expect(state.bus).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(state.bus).toHaveLength(2);
    stop();
  });

  it("a failed bus write is retried on the next tick (never falls back to the owner)", async () => {
    state.busFails = true;
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.bus).toHaveLength(0); expect(state.outbound).toEqual([]);
    state.busFails = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.bus).toHaveLength(1);
    stop();
  });

  it("agents without a prompt cause no message", async () => {
    state.pane = "just output\n❯ ";
    const stop = startSessionHygiene(cfg);
    await vi.advanceTimersByTimeAsync(20_000 * 5);
    expect(state.bus).toEqual([]); expect(state.outbound).toEqual([]);
    stop();
  });
});

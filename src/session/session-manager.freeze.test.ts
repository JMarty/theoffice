import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** While the fleet is frozen the deliverer must not hand anything to an agent; thawed, the same queue drains. */
const deliver = vi.fn();
const markFailed = vi.fn();
let frozen = false;
const items = [{ id: 13, agent_id: "darryl", source: "bus", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 }];

vi.mock("./tmux.js", () => ({ hasSession: () => true, sessionNameFor: (id: string) => `agent-${id}` }));
vi.mock("../queue/index.js", () => ({ listQueued: () => items, markFailed: (...a: unknown[]) => markFailed(...a) }));
vi.mock("../agents.js", () => ({ loadAgents: () => [{ id: "darryl", dir: "/tmp/darryl", enabled: true }] }));
vi.mock("./runtime.js", () => ({ runtimeFor: () => ({ isBusy: () => false, deliver }) }));
vi.mock("../fleet/freeze.js", () => ({ isFrozen: () => frozen }));

const { startDeliverer } = await import("./session-manager.js");
const cfg = { tmux: { socket: "test" } } as never;

beforeEach(() => { vi.useFakeTimers(); deliver.mockReset(); deliver.mockResolvedValue(undefined); frozen = false; });
afterEach(() => vi.useRealTimers());

describe("deliverer honours the fleet freeze", () => {
  it("frozen: nothing is delivered; thawed: the queued item is delivered", async () => {
    const stop = startDeliverer(cfg);
    try {
      frozen = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(deliver).not.toHaveBeenCalled();
      frozen = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(deliver).toHaveBeenCalled();
    } finally { stop(); }
  });
});

import { describe, it, expect } from "vitest";
import { decideQuotaAction, quotaPressure, QUOTA_DEFAULTS, type QuotaSnapshot } from "./gate.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const snap = (five: number | null, seven: number | null, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  source: "authoritative",
  fetchedAtMs: NOW - 60_000,
  fiveHour: five === null ? null : { usedPercent: five, resetsAtMs: NOW + 3 * 3600_000 },
  sevenDay: seven === null ? null : { usedPercent: seven, resetsAtMs: NOW + 3 * 86400_000 },
  ...over,
});
const decide = (s: QuotaSnapshot | null, workClass: "background" | "owner-facing" = "background", cfg = {}) =>
  decideQuotaAction({ snapshot: s, nowMs: NOW, workClass, config: { ...QUOTA_DEFAULTS, ...cfg } });

describe("quotaPressure", () => {
  it("is the highest window, or null when nothing is reported", () => {
    expect(quotaPressure(snap(40, 70))).toBe(70);
    expect(quotaPressure(snap(null, null))).toBeNull();
    expect(quotaPressure(null)).toBeNull();
  });
});

describe("decideQuotaAction", () => {
  it("runs background work below the threshold", () => {
    expect(decide(snap(50, 40)).action).toBe("run");
  });

  it("defers background work at or above deferAtPercent on EITHER window", () => {
    expect(decide(snap(85, 10)).action).toBe("defer");
    expect(decide(snap(10, 90)).action).toBe("defer");
    expect(decide(snap(84.9, 84.9)).action).toBe("run");
  });

  it("owner-facing work ALWAYS runs, even at 100%", () => {
    expect(decide(snap(100, 100), "owner-facing")).toMatchObject({ action: "run", reason: "owner-facing" });
  });

  it("a near-full window that resets within 30 min defers earlier (70%+) because waiting is cheaper than spending the tail", () => {
    const s = snap(75, 10, { fiveHour: { usedPercent: 75, resetsAtMs: NOW + 20 * 60_000 } });
    expect(decide(s).action).toBe("defer");
    expect(decide(snap(75, 10)).action).toBe("run"); // same 75% but reset is hours away
  });

  it("FAIL OPEN: no snapshot, stale snapshot, untrusted source, or no percentages all run", () => {
    expect(decide(null).reason).toBe("no-snapshot");
    expect(decide(snap(99, 99, { fetchedAtMs: NOW - 21 * 60_000 })).reason).toBe("stale-snapshot");
    expect(decide(snap(99, 99, { source: "estimate" })).reason).toBe("untrusted-source");
    expect(decide(snap(null, null)).reason).toBe("no-percentages");
    for (const s of [null, snap(99, 99, { fetchedAtMs: 0 }), snap(99, 99, { source: "x" }), snap(null, null)]) expect(decide(s).action).toBe("run");
  });

  it("thresholds are configurable", () => {
    expect(decide(snap(60, 10), "background", { deferAtPercent: 50 }).action).toBe("defer");
  });
});

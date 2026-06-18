import { describe, it, expect } from "vitest";
import { decideCodexOutcome, decideGeminiOutcome } from "./exec-outcome.js";

describe("decideCodexOutcome", () => {
  it("clean exit + turn.completed -> delivered", () => {
    expect(decideCodexOutcome({ code: 0, sawCompleted: true, sawUsageLimit: false })).toEqual({ kind: "delivered" });
  });

  it("usage cap takes precedence over everything (even a clean completed turn)", () => {
    // a cap can ride on a 0-exit; it must hold (not deliver, not burn the budget).
    expect(decideCodexOutcome({ code: 0, sawCompleted: true, sawUsageLimit: true })).toEqual({ kind: "usage" });
    expect(decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: true })).toEqual({ kind: "usage" });
  });

  it("watchdog timeout -> retry (never a silent delivered)", () => {
    expect(decideCodexOutcome({ code: null, sawCompleted: false, sawUsageLimit: false, timedOut: true }))
      .toEqual({ kind: "retry", why: "turn watchdog timeout" });
  });

  it("clean exit WITHOUT turn.completed -> retry (not delivered)", () => {
    const o = decideCodexOutcome({ code: 0, sawCompleted: false, sawUsageLimit: false });
    expect(o.kind).toBe("retry");
  });

  it("non-zero exit -> retry", () => {
    const o = decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: false });
    expect(o.kind).toBe("retry");
  });
});

describe("decideGeminiOutcome", () => {
  it("clean exit WITH output -> delivered", () => {
    expect(decideGeminiOutcome({ code: 0, sawUsageLimit: false, sawOutput: true })).toEqual({ kind: "delivered" });
  });

  it("clean exit with NO output -> retry (the silent-swallow bug: exit 0 alone is not success)", () => {
    const o = decideGeminiOutcome({ code: 0, sawUsageLimit: false, sawOutput: false });
    expect(o.kind).toBe("retry");
  });

  it("usage cap on a 0-exit -> hold, not delivered", () => {
    expect(decideGeminiOutcome({ code: 0, sawUsageLimit: true, sawOutput: false })).toEqual({ kind: "usage" });
    // even if it printed the cap message as 'output', the cap still wins.
    expect(decideGeminiOutcome({ code: 0, sawUsageLimit: true, sawOutput: true })).toEqual({ kind: "usage" });
  });

  it("watchdog timeout -> retry", () => {
    expect(decideGeminiOutcome({ code: null, sawUsageLimit: false, sawOutput: false, timedOut: true }))
      .toEqual({ kind: "retry", why: "turn watchdog timeout" });
  });

  it("non-zero exit -> retry", () => {
    const o = decideGeminiOutcome({ code: 1, sawUsageLimit: false, sawOutput: false });
    expect(o.kind).toBe("retry");
  });
});

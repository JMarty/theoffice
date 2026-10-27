import { describe, it, expect, beforeEach } from "vitest";
import { guardDecision, setSnapshotForTest, resetGuardForTest } from "./guard.js";
import type { QuotaSnapshot } from "./gate.js";
import type { EngineConfig } from "../types.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const hot: QuotaSnapshot = { source: "authoritative", fetchedAtMs: NOW - 1000, fiveHour: { usedPercent: 95, resetsAtMs: NOW + 3600_000 }, sevenDay: null };
const cfgWith = (quotaGuard?: EngineConfig["quotaGuard"]) => ({ quotaGuard }) as EngineConfig;

beforeEach(() => resetGuardForTest());

describe("guardDecision", () => {
  it("is off (run, 'disabled') unless the tenant enables it", () => {
    setSnapshotForTest(hot);
    expect(guardDecision(cfgWith(), "background", NOW)).toMatchObject({ run: true, reason: "disabled" });
    expect(guardDecision(cfgWith({ enabled: false }), "background", NOW).run).toBe(true);
  });

  it("enforce mode defers background work under pressure and never owner-facing work", () => {
    setSnapshotForTest(hot);
    const c = cfgWith({ enabled: true, mode: "enforce" });
    expect(guardDecision(c, "background", NOW)).toMatchObject({ run: false, wouldDefer: true });
    expect(guardDecision(c, "owner-facing", NOW)).toMatchObject({ run: true, wouldDefer: false });
  });

  it("shadow mode (the default when enabled) reports wouldDefer but still runs", () => {
    setSnapshotForTest(hot);
    expect(guardDecision(cfgWith({ enabled: true }), "background", NOW)).toMatchObject({ run: true, wouldDefer: true });
  });

  it("fails open when nothing has been fetched", () => {
    expect(guardDecision(cfgWith({ enabled: true, mode: "enforce" }), "background", NOW)).toMatchObject({ run: true, reason: "no-snapshot" });
  });

  it("honours a tenant threshold", () => {
    setSnapshotForTest({ ...hot, fiveHour: { usedPercent: 60, resetsAtMs: NOW + 3600_000 } });
    expect(guardDecision(cfgWith({ enabled: true, mode: "enforce", deferAtPercent: 50 }), "background", NOW).run).toBe(false);
  });
});

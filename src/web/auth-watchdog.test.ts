import { describe, expect, it } from "vitest";
import { ALERT_HOURS, alertSlot, dueForAlert } from "./auth-watchdog.js";

/**
 * These guard the 2026-08-21 incident: an unchanged "expiring-soon" credential produced 14 identical
 * DMs in 13 hours because the only gate was a one-hour timer. The owner asked for two a day.
 */
describe("alertSlot", () => {
  it("names one window per reminder hour", () => {
    expect(alertSlot(new Date(2026, 7, 21, 8, 0))).toBe("2026-08-21:8");
    expect(alertSlot(new Date(2026, 7, 21, 20, 55))).toBe("2026-08-21:20");
  });

  it("is null outside the windows, including the whole night", () => {
    for (const h of [0, 2, 5, 7, 9, 13, 19, 21, 23]) {
      expect(alertSlot(new Date(2026, 7, 21, h, 30))).toBeNull();
    }
  });

  it("uses exactly the configured hours", () => {
    expect([...ALERT_HOURS]).toEqual([8, 20]);
  });
});

describe("dueForAlert", () => {
  const base = { status: "expiring-soon", lastStatus: "expiring-soon", slot: null, lastSlot: "" };

  it("tells a NEW problem at once, even outside a window", () => {
    expect(dueForAlert({ ...base, status: "expired", lastStatus: "expiring-soon" })).toBe(true);
  });

  it("stays silent between windows for a problem already reported", () => {
    expect(dueForAlert(base)).toBe(false);
  });

  it("repeats once when a window opens", () => {
    expect(dueForAlert({ ...base, slot: "2026-08-21:8" })).toBe(true);
  });

  it("does not repeat twice inside the same window", () => {
    expect(dueForAlert({ ...base, slot: "2026-08-21:8", lastSlot: "2026-08-21:8" })).toBe(false);
  });

  it("repeats again in the evening window, then next morning: two a day", () => {
    expect(dueForAlert({ ...base, slot: "2026-08-21:20", lastSlot: "2026-08-21:8" })).toBe(true);
    expect(dueForAlert({ ...base, slot: "2026-08-22:8", lastSlot: "2026-08-21:20" })).toBe(true);
  });

  it("a five-minute tick inside a window never produces a second DM", () => {
    let lastSlot = "";
    let sent = 0;
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const slot = alertSlot(new Date(2026, 7, 21, h, m));
        if (dueForAlert({ ...base, slot, lastSlot })) {
          sent++;
          if (slot) lastSlot = slot;
        }
      }
    }
    expect(sent).toBe(2);
  });
});

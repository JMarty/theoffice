import { describe, expect, it } from "vitest";
import { ALERT_HOURS, alertSlot, dueForAlert, dueForSeverity } from "./auth-watchdog.js";

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

/**
 * These guard the 2026-08-26 merge, where two independent fixes for the same problem were combined:
 * upstream split the cadence by severity, this branch capped repeats to two fixed local windows.
 * The resolution keeps BOTH — hourly for hard-down, windows for expiring-soon — and that decision
 * lives in dueForSeverity. Nothing covered it until these tests: the suite was green while the one
 * branch that chooses between the two cadences had no test at all.
 */
describe("dueForSeverity", () => {
  const HOUR = 60 * 60 * 1000;
  const T = (h: number, m = 0) => new Date(2026, 7, 26, h, m).getTime();
  const base = { slot: null as string | null, lastSlot: "", urgentMs: HOUR };

  describe("hard-down: hourly, ignoring the windows", () => {
    it("repeats an unchanged hard-down after an hour, at 03:00 — a mute fleet is worth waking up for", () => {
      expect(
        dueForSeverity({ ...base, status: "expired", lastStatus: "expired", now: T(3), lastAlertAt: T(3) - HOUR - 1 }),
      ).toBe(true);
    });

    it("stays quiet inside the hour", () => {
      expect(
        dueForSeverity({ ...base, status: "expired", lastStatus: "expired", now: T(3), lastAlertAt: T(3) - 59 * 60_000 }),
      ).toBe(false);
    });

    it("is NOT gated by ALERT_HOURS: 09:00 is outside a window and it still repeats", () => {
      expect(
        dueForSeverity({ ...base, status: "expired", lastStatus: "expired", now: T(9), lastAlertAt: T(9) - HOUR - 1 }),
      ).toBe(true);
    });
  });

  describe("expiring-soon: windows only, never the hourly timer", () => {
    it("does NOT repeat outside a window even a full day later — this is the 2:57 spam it replaces", () => {
      expect(
        dueForSeverity({
          ...base,
          status: "expiring-soon",
          lastStatus: "expiring-soon",
          now: T(2, 57),
          lastAlertAt: T(2, 57) - 24 * HOUR,
        }),
      ).toBe(false);
    });

    it("repeats when a window opens, with the hourly timer nowhere near due", () => {
      expect(
        dueForSeverity({
          ...base,
          status: "expiring-soon",
          lastStatus: "expiring-soon",
          slot: alertSlot(new Date(2026, 7, 26, ALERT_HOURS[0]!)),
          lastSlot: "",
          now: T(ALERT_HOURS[0]!),
          lastAlertAt: T(ALERT_HOURS[0]!) - 60_000,
        }),
      ).toBe(true);
    });

    it("does not repeat twice inside the same window", () => {
      const slot = alertSlot(new Date(2026, 7, 26, ALERT_HOURS[0]!));
      expect(
        dueForSeverity({
          ...base,
          status: "expiring-soon",
          lastStatus: "expiring-soon",
          slot,
          lastSlot: slot!,
          now: T(ALERT_HOURS[0]!, 30),
          lastAlertAt: T(ALERT_HOURS[0]!),
        }),
      ).toBe(false);
    });
  });

  describe("a status change alerts at once on either path", () => {
    it("degrade expiring-soon → hard-down pages immediately, mid-night, inside the hour", () => {
      expect(
        dueForSeverity({
          ...base,
          status: "expired",
          lastStatus: "expiring-soon",
          now: T(3),
          lastAlertAt: T(3) - 60_000,
        }),
      ).toBe(true);
    });

    it("a NEW expiring-soon warning is told at once, outside any window", () => {
      expect(
        dueForSeverity({ ...base, status: "expiring-soon", lastStatus: "healthy", now: T(3), lastAlertAt: T(3) - 60_000 }),
      ).toBe(true);
    });
  });
});

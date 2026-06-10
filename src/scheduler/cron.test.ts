import { describe, it, expect } from "vitest";
import { isDueNow } from "./cron.js";

const TZ = "Europe/Budapest";

describe("isDueNow (timezone-aware)", () => {
  it("fires 08:00 Budapest in summer (CEST = UTC+2)", () => {
    const ms = Date.parse("2026-06-09T06:00:00Z"); // 08:00 Budapest
    expect(isDueNow("0 8 * * *", ms, TZ)).toBe(true);
    expect(isDueNow("0 9 * * *", ms, TZ)).toBe(false);
  });

  it("fires 08:00 Budapest in winter (CET = UTC+1) — DST handled", () => {
    const ms = Date.parse("2026-01-15T07:00:00Z"); // 08:00 Budapest
    expect(isDueNow("0 8 * * *", ms, TZ)).toBe(true);
  });

  it("every-30-min matches on the half hour, not in between", () => {
    expect(isDueNow("*/30 * * * *", Date.parse("2026-06-09T06:00:00Z"), TZ)).toBe(true);
    expect(isDueNow("*/30 * * * *", Date.parse("2026-06-09T06:15:00Z"), TZ)).toBe(false);
    expect(isDueNow("*/30 * * * *", Date.parse("2026-06-09T06:30:00Z"), TZ)).toBe(true);
  });

  it("matches anywhere within the due minute (tick jitter tolerant)", () => {
    expect(isDueNow("0 8 * * *", Date.parse("2026-06-09T06:00:42Z"), TZ)).toBe(true);
  });

  it("weekday restriction works", () => {
    // 2026-06-09 is a Tuesday
    expect(isDueNow("0 8 * * 2", Date.parse("2026-06-09T06:00:00Z"), TZ)).toBe(true);
    expect(isDueNow("0 8 * * 0", Date.parse("2026-06-09T06:00:00Z"), TZ)).toBe(false);
  });

  it("invalid expression -> not due (no throw)", () => {
    expect(isDueNow("not a cron", Date.now(), TZ)).toBe(false);
  });
});

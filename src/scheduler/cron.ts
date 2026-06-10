import parser from "cron-parser";

/**
 * True if a 5-field cron expression is due in the minute containing `nowMs`,
 * evaluated in IANA timezone `tz` (e.g. "Europe/Budapest"). Pure + testable.
 *
 * We evaluate against the END of the current minute and take the most recent
 * scheduled time at or before it; if that falls in the current minute, it's due.
 * Combined with the inbound-queue dedup key, this fires each schedule exactly
 * once per matching minute regardless of tick jitter.
 */
export function isDueNow(expr: string, nowMs: number, tz: string): boolean {
  const minuteStart = nowMs - (nowMs % 60000);
  const endOfMinute = new Date(minuteStart + 59_999);
  try {
    const it = parser.parseExpression(expr, { currentDate: endOfMinute, tz });
    const prevMs = it.prev().toDate().getTime();
    return Math.floor(prevMs / 60000) === Math.floor(nowMs / 60000);
  } catch {
    return false;
  }
}

/** Stable per-minute key for dedup (UTC minute index is fine for uniqueness). */
export function minuteKey(nowMs: number): number {
  return Math.floor(nowMs / 60000);
}

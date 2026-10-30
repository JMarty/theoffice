import { readFileSync } from "node:fs";
import type { QuotaSnapshot, QuotaWindow } from "./gate.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function win(w: unknown): QuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const o = w as { utilization?: unknown; resets_at?: unknown };
  if (typeof o.utilization !== "number" || Number.isNaN(o.utilization)) return null;
  const ms = typeof o.resets_at === "string" ? Date.parse(o.resets_at) : NaN;
  return { usedPercent: o.utilization, resetsAtMs: Number.isNaN(ms) ? null : ms };
}

/** Map the OAuth usage body ({five_hour, seven_day: {utilization 0..100, resets_at ISO}}) to a snapshot; null if it is not one. */
export function parseUsage(body: unknown, nowMs: number): QuotaSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = win(b.five_hour), sevenDay = win(b.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { source: "authoritative", fetchedAtMs: nowMs, fiveHour, sevenDay };
}

/**
 * One GET of the usage endpoint. The token travels only in the Authorization header; every failure (HTTP error, bad
 * JSON, a throwing fetch) returns null and nothing from the error is forwarded, so the token can never reach a log.
 */
export async function fetchUsageSnapshot(token: string, fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<QuotaSnapshot | null> {
  try {
    const r = await fetchImpl(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return parseUsage(await r.json(), nowMs);
  } catch {
    return null;
  }
}

/** claudeAiOauth.accessToken from a Claude credentials file, or null when missing, unreadable or expired. */
export function readAccessToken(file: string, nowMs = Date.now()): string | null {
  try {
    const c = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
    if (!c?.accessToken) return null;
    if (typeof c.expiresAt === "number" && c.expiresAt <= nowMs) return null;
    return c.accessToken;
  } catch {
    return null;
  }
}

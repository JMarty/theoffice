import { describe, it, expect } from "vitest";
import { parseUsage, fetchUsageSnapshot, readAccessToken } from "./snapshot.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const BODY = {
  five_hour: { utilization: 36.0, resets_at: "2026-10-27T20:00:00.213101+00:00" },
  seven_day: { utilization: 23, resets_at: "2026-11-02T23:00:00+00:00" },
  other_thing: null,
};

describe("parseUsage", () => {
  it("maps the OAuth usage body to the two windows (percent 0..100, reset in ms)", () => {
    const s = parseUsage(BODY, NOW)!;
    expect(s.source).toBe("authoritative");
    expect(s.fiveHour).toEqual({ usedPercent: 36, resetsAtMs: Date.parse("2026-10-27T20:00:00.213101+00:00") });
    expect(s.sevenDay?.usedPercent).toBe(23);
    expect(s.fetchedAtMs).toBe(NOW);
  });
  it("returns null for anything that is not a usage body, and tolerates a missing window", () => {
    expect(parseUsage(null, NOW)).toBeNull();
    expect(parseUsage("x", NOW)).toBeNull();
    expect(parseUsage({}, NOW)).toBeNull();
    expect(parseUsage({ five_hour: { utilization: 10, resets_at: "bad" } }, NOW)!.fiveHour).toEqual({ usedPercent: 10, resetsAtMs: null });
  });
});

describe("fetchUsageSnapshot", () => {
  it("sends the token only in the Authorization header and parses the answer", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify(BODY), { status: 200 }); }) as unknown as typeof fetch;
    const s = await fetchUsageSnapshot("SECRET-TOKEN", f, NOW);
    expect(s?.fiveHour?.usedPercent).toBe(36);
    expect(seen!.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET-TOKEN");
    expect(seen!.url).not.toContain("SECRET");
  });
  it("fails open: HTTP error, bad JSON and a thrown fetch all give null, and the error never carries the token", async () => {
    const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const boom = (async () => { throw new Error("connect failed SECRET-TOKEN"); }) as unknown as typeof fetch;
    for (const f of [bad, junk, boom]) expect(await fetchUsageSnapshot("SECRET-TOKEN", f, NOW)).toBeNull();
  });
});

describe("readAccessToken", () => {
  it("reads claudeAiOauth.accessToken, and returns null for a missing/garbled/expired file", () => {
    const d = mkdtempSync(join(tmpdir(), "office-cred-"));
    try {
      const ok = join(d, "ok.json"); writeFileSync(ok, JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3600_000 } }));
      const expired = join(d, "old.json"); writeFileSync(expired, JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: NOW - 1000 } }));
      const junk = join(d, "junk.json"); writeFileSync(junk, "{{");
      expect(readAccessToken(ok, NOW)).toBe("tok");
      expect(readAccessToken(expired, NOW)).toBeNull();
      expect(readAccessToken(junk, NOW)).toBeNull();
      expect(readAccessToken(join(d, "none.json"), NOW)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

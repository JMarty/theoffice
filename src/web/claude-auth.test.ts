import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentialState,
  paneLooksSignedOut,
  extractOAuthUrl,
  formatDuration,
  restartTargets,
  trackBusySkips,
  paneIsBusy,
  type AgentAuthState,
} from "./claude-auth.js";

const tmps: string[] = [];
function credFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  tmps.push(dir);
  const f = join(dir, ".credentials.json");
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("readCredentialState", () => {
  it("reports a live credential and never leaks token material", () => {
    const f = credFile({
      claudeAiOauth: {
        expiresAt: Date.now() + HOUR,
        refreshTokenExpiresAt: Date.now() + 29 * DAY,
        refreshToken: "rt-secret",
        accessToken: "at-secret",
      },
    });
    const s = readCredentialState(f);
    expect(s.present).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.refreshExpired).toBe(false);
    expect(s.hasRefreshToken).toBe(true);
    // the whole point of returning a shape instead of the object: no secret can reach the dashboard
    expect(JSON.stringify(s)).not.toContain("rt-secret");
    expect(JSON.stringify(s)).not.toContain("at-secret");
  });

  // The distinction that keeps this from becoming a nightly false alarm: the ACCESS token lapses
  // every ~8h by design and Claude Code renews it silently. Only the REFRESH token forces a login.
  it("an expired access token with a live refresh token is NOT a refresh-expiry", () => {
    const s = readCredentialState(
      credFile({
        claudeAiOauth: { expiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() + 20 * DAY, refreshToken: "x" },
      }),
    );
    expect(s.expired).toBe(true); // access token is stale...
    expect(s.refreshExpired).toBe(false); // ...but it can still renew itself: no alarm
    expect(s.refreshExpiringSoon).toBe(false);
  });

  it("flags an expired refresh token — the state that forces an interactive login", () => {
    const s = readCredentialState(
      credFile({
        claudeAiOauth: { expiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() - 1000, refreshToken: "x" },
      }),
    );
    expect(s.refreshExpired).toBe(true);
  });

  it("treats a missing refresh token as expired (nothing can renew)", () => {
    const s = readCredentialState(credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR } }));
    expect(s.hasRefreshToken).toBe(false);
    expect(s.refreshExpired).toBe(true);
  });

  it("warns only inside the refresh-expiry window, not on a fresh 30-day token", () => {
    const soon = readCredentialState(
      credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshTokenExpiresAt: Date.now() + 2 * DAY, refreshToken: "x" } }),
    );
    expect(soon.refreshExpiringSoon).toBe(true);
    const fresh = readCredentialState(
      credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshTokenExpiresAt: Date.now() + 29 * DAY, refreshToken: "x" } }),
    );
    expect(fresh.refreshExpiringSoon).toBe(false);
  });

  it("stays quiet when the refresh expiry field is absent (older credential shape)", () => {
    const s = readCredentialState(credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshToken: "x" } }));
    expect(s.refreshExpired).toBe(false);
    expect(s.refreshExpiringSoon).toBe(false);
  });

  it("treats a missing or unparseable file as absent rather than throwing", () => {
    expect(readCredentialState("/nope/does/not/exist.json").present).toBe(false);
    expect(readCredentialState(credFile("{ not json")).present).toBe(false);
    expect(readCredentialState(credFile({ somethingElse: true })).present).toBe(false);
  });
});

describe("paneLooksSignedOut", () => {
  // Banners are assembled from parts so this file never contains a rendered one: a literal here
  // would make `grep`, a code review, or a failing-test dump arm the reader's own pane.
  const banner = (state: string, action = "Please run /login") => `${state} · ${action}`;

  // The 2026-07-25 outage rendered "Run /login"; v2.1.220 renders "Please run /login". Both count.
  it("detects the signed-out banner Claude Code renders", () => {
    expect(paneLooksSignedOut(`  ▘▘ ▝▝    Opus 4.8 · API Usage Billing\n   ${banner("Not logged in", "Run /login")}`)).toBe(true);
    expect(paneLooksSignedOut(`● ${banner("Login expired")}`)).toBe(true);
    expect(paneLooksSignedOut(`● ${banner("OAuth token revoked")}`)).toBe(true);
  });

  it("does not fire on a healthy signed-in pane", () => {
    expect(paneLooksSignedOut(" ▐▛███▜▌   Claude Code v2.1.220\n▝▜█████▛▘  Opus 4.8 · Claude Max\n❯ Try \"edit types.ts\"")).toBe(false);
  });

  // The regression that started all this: an agent that merely PRINTS the state words — reviewing
  // this code, quoting an API error, relaying the incident — was read as signed out, and with a
  // valid credential the watchdog then restarted the pane that was doing the investigating.
  it("does not fire on an agent merely talking about being signed out", () => {
    expect(paneLooksSignedOut('const MARKERS = ["Not logged in", "Login expired", "Please run /login"];')).toBe(false);
    expect(paneLooksSignedOut("The pane said Not logged in, so I checked whether it should run /login.")).toBe(false);
    expect(paneLooksSignedOut("API Error: 401 Invalid authentication credentials")).toBe(false);
  });

  // A banner split across two REAL lines is prose, not a banner: only tmux's own wrap-joining
  // (capture with join: true) may put it back together.
  it("does not fire when the two halves sit on separate lines", () => {
    expect(paneLooksSignedOut("Login expired\n· Please run /login")).toBe(false);
  });
});

describe("trackBusySkips", () => {
  it("escalates once the same agent has been skipped N ticks in a row", () => {
    let map = new Map<string, number>();
    for (let i = 1; i < 3; i++) {
      const r = trackBusySkips(["zeus"], map, 3);
      map = r.next;
      expect(r.escalate).toEqual([]);
    }
    expect(trackBusySkips(["zeus"], map, 3).escalate).toEqual(["zeus"]);
  });

  // The reason the counter is per agent and not per candidate set: a set-wide counter is reset by
  // any change to the set, so a neighbour flapping in and out would keep the stuck agent silent
  // forever — the noisy case, which is exactly the one a human needs to hear about.
  it("escalates a stuck agent even while another agent flaps in and out", () => {
    let map = new Map<string, number>();
    let escalate: string[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const skipped = tick % 2 === 0 ? ["zeus", "argus"] : ["zeus"];
      const r = trackBusySkips(skipped, map, 3);
      map = r.next;
      escalate = r.escalate;
    }
    expect(escalate).toEqual(["zeus"]);
  });

  it("forgets an agent as soon as it stops being skipped", () => {
    const first = trackBusySkips(["zeus"], new Map(), 3);
    expect(trackBusySkips([], first.next, 3).next.size).toBe(0);
    expect(trackBusySkips(["zeus"], new Map(), 3).next.get("zeus")).toBe(1);
  });
});

describe("extractOAuthUrl", () => {
  const FULL =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=Sa_tEq&code_challenge_method=S256&state=xyz";

  it("pulls the authorize URL out of the login pane", () => {
    const pane = `Opening browser to sign in…
If the browser didn't open, visit: ${FULL}
Paste code here if prompted >`;
    expect(extractOAuthUrl(pane)).toBe(FULL);
  });

  it("re-joins a URL hard-wrapped across pane rows, stopping at the prose that follows", () => {
    const pane = `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code
_challenge=Sa_tEq&code_challenge_method=S256&state=xyz
Paste code here if prompted >`;
    expect(extractOAuthUrl(pane)).toBe(FULL);
  });

  it("refuses to return a TRUNCATED url — a dead link is worse than none", () => {
    // Missing code_challenge/state => not fully printed yet; caller must keep polling.
    const pane = "visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    expect(extractOAuthUrl(pane)).toBeNull();
  });

  it("returns null when no URL is present yet", () => {
    expect(extractOAuthUrl("Opening browser to sign in…")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders human units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2.0 h");
    expect(formatDuration(4 * 86400)).toBe("4 d");
  });
});

describe("restartTargets", () => {
  const state = (over: Partial<AgentAuthState>): AgentAuthState => ({
    id: "a",
    displayName: "A",
    runtime: "claude",
    signedOut: false,
    noSession: false,
    busy: false,
    ...over,
  });

  // The whole point of the guard: a pane mid-turn is doing real work for someone. Killing it
  // destroys that conversation, and the banner match that triggered it is usually the agent
  // merely PRINTING a marker (reviewing this file, quoting an API error) rather than signed out.
  it("never restarts a signed-out agent whose pane is busy", () => {
    const r = restartTargets([state({ id: "zeus", signedOut: true, busy: true })]);
    expect(r.restart).toEqual([]);
    expect(r.skippedBusy).toEqual(["zeus"]);
  });
});

describe("paneIsBusy", () => {
  const SEP = "─".repeat(40);
  const FOOTER = "  bypass permissions on (shift+tab to cycle)";
  const idle = ["assistant reply text", SEP, "❯ ", SEP, FOOTER].join("\n");
  const working = ["✻ Working… (3s · ↓ 0.1k tokens · esc to interrupt)", SEP, "❯ ", SEP, FOOTER].join("\n");

  it("treats a clean idle prompt as not busy", () => {
    expect(paneIsBusy(idle)).toBe(false);
  });

  it("treats a mid-turn pane as busy", () => {
    expect(paneIsBusy(working)).toBe(true);
  });

  // Conservative on purpose: the cost of a wrong "busy" is a 5-minute wait for the next tick,
  // the cost of a wrong "idle" is a killed conversation. Anything we cannot positively classify
  // as a clean idle prompt must count as busy.
  it("treats an unclassifiable pane as busy rather than guessing it is safe to kill", () => {
    expect(paneIsBusy("garbled output with no footer")).toBe(true);
    expect(paneIsBusy("")).toBe(true);
  });
});

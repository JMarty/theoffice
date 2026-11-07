import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createHandler, isDisabled, type McpConfig } from "./server.js";
import { loadTestConfig } from "./test-helpers.js";
import type { GoogleIdentity } from "./oauth.js";

const CB = "https://claude.ai/api/mcp/auth_callback";
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let dir: string, srv: http.Server, base: string, cfg: McpConfig, identity: GoogleIdentity;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
  identity = { email: "owner@example.com", emailVerified: true, sub: "g-1" };
  srv = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(srv.address() as { port: number }).port}`;
  cfg = {
    ...loadTestConfig({ OFFICE_TENANT_ROOT: dir } as NodeJS.ProcessEnv),
    allowedIps: ["127.0.0.1"],
    publicUrl: base,
    googleClientId: "gid",
    allowedEmails: ["owner@example.com"],
    stateFile: path.join(dir, "oauth.json"),
    disabledFile: path.join(dir, "mcp.disabled"),
    logFile: path.join(dir, "calls.log"),
  };
  handler = createHandler(cfg, fetch, async (_c, _r, nonce) => ({ ...identity, nonce }));
});
let handler: http.RequestListener = () => undefined;
afterEach(() => {
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });

async function register(redirect = CB, name = "Claude") {
  return post("/register", {
    client_name: name,
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

// Walks the whole sign-in and returns the tokens.
async function signIn() {
  const reg = (await (await register()).json()) as { client_id: string };
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: CB,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st1",
    resource: base + "/mcp",
  });
  const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  const html = await page.text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
  const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
  const consent = await fetch(base + "/oauth/consent", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "txn=" + txn,
    redirect: "manual",
  });
  const g = new URL(consent.headers.get("location")!);
  const cb = await fetch(`${base}/oauth/google/callback?code=gcode&state=${g.searchParams.get("state")}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  return { reg, verifier, page, html, consent, g, cb, cookie };
}
async function exchange(clientId: string, code: string, verifier: string) {
  const r = await fetch(base + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CB,
      resource: base + "/mcp",
    }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, string> };
}
const toolsList = (token?: string) =>
  post(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { ...MCP_HEADERS, ...(token ? { Authorization: "Bearer " + token } : {}) },
  );

describe("fleet mcp sign-in", () => {
  it("refuses a client that registers a foreign redirect URI", async () => {
    const r = await register("https://evil.example/cb");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });

  it("answers 401 with a pointer to the metadata when there is no token", async () => {
    const r = await toolsList();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("the old token-in-URL path is gone", async () => {
    expect((await post("/mcp/abc_DEF-123", {})).status).toBe(404);
  });

  it("always asks first, escapes the client name, refuses framing", async () => {
    const reg = (await (await register(CB, "<script>alert(1)</script>")).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: CB,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("claude.ai");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("signs the allowed owner in, serves tools, rotates and tolerates a retried refresh", async () => {
    const s = await signIn();
    expect(s.g.host).toBe("accounts.google.com");
    expect(s.cb.status).toBe(302);
    const back = new URL(s.cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(CB);
    expect(back.searchParams.get("state")).toBe("st1");
    const t = await exchange(s.reg.client_id, back.searchParams.get("code")!, s.verifier);
    expect(t.status).toBe(200);
    const ok = await toolsList(t.json.access_token);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("fleet_status");
    expect(
      (await fetch(base + "/mcp", { method: "GET", headers: { Authorization: "Bearer " + t.json.access_token } }))
        .status,
    ).toBe(405);

    const refresh = (rt: string) =>
      fetch(base + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: s.reg.client_id, refresh_token: rt }),
      });
    const r1 = await refresh(t.json.refresh_token!);
    expect(r1.status).toBe(200);
    const n = (await r1.json()) as Record<string, string>;
    expect((await toolsList(n.access_token)).status).toBe(200);
    expect((await refresh(t.json.refresh_token!)).status).toBe(200); // a retry inside the grace window rotates again (see grants-survive.test.ts for the replay after it)
    expect((await toolsList(n.access_token)).status).toBe(200);
  });

  it("refuses a second Google account and an unverified address", async () => {
    identity = { email: "stranger@example.com", emailVerified: true, sub: "g-2" };
    let s = await signIn();
    expect(s.cb.status).toBe(403);
    identity = { email: "owner@example.com", emailVerified: false, sub: "g-1" };
    s = await signIn();
    expect(s.cb.status).toBe(403);
  });

  it("pins the Google sub after the first login", async () => {
    expect((await signIn()).cb.status).toBe(302);
    identity = { email: "owner@example.com", emailVerified: true, sub: "g-other" };
    expect((await signIn()).cb.status).toBe(403);
  });

  it("does not take a callback without the cookie of the browser that started it", async () => {
    const s = await signIn();
    expect(s.cb.status).toBe(302);
    const reg = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: CB,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1]!;
    const noCookie = await fetch(base + "/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "txn=" + txn,
      redirect: "manual",
    });
    expect(noCookie.status).toBe(403);
  });

  it("rejects a token request for another resource", async () => {
    const reg = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: CB,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      state: "s",
      resource: "https://other.example/mcp",
    });
    const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    expect(r.headers.get("location") ?? "").toContain("error=invalid_target");
  });
});

describe("fleet mcp hardening", () => {
  it("anonymous junk cannot trip the kill switch", async () => {
    cfg.tripAfter = 3;
    for (let i = 0; i < 15; i++) await fetch(`${base}/oauth/google/callback?state=junk${i}&code=x`);
    for (let i = 0; i < 5; i++)
      await fetch(base + "/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "txn=nope",
      });
    expect(fs.existsSync(cfg.disabledFile)).toBe(false);
    expect((await toolsList()).status).toBe(401);
  });
  it("prototype names as client ids do not crash", async () => {
    for (const id of ["__proto__", "constructor", "toString"]) {
      const r = await fetch(
        `${base}/authorize?response_type=code&client_id=${id}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256`,
        { redirect: "manual" },
      );
      expect(r.status).toBeLessThan(500);
    }
  });
  it("caps what a registration can store", async () => {
    const r = await register(CB, "n".repeat(90_000));
    const j = (await r.json()) as { client_name: string };
    expect(j.client_name.length).toBe(80);
    expect(fs.statSync(cfg.stateFile).size).toBeLessThan(5_000);
  });
  it("accepts the resource with a trailing slash", async () => {
    const reg = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: CB,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      resource: base + "/mcp/",
    });
    expect((await fetch(`${base}/authorize?${q}`, { redirect: "manual" })).status).toBe(200);
  });
  it("refuses to start on a damaged state file", () => {
    fs.writeFileSync(cfg.stateFile, "{not json");
    expect(() => createHandler(cfg, fetch, async () => identity)).toThrow();
  });
  it("denies an id_token without the nonce it was asked for", async () => {
    handler = createHandler(cfg, fetch, async () => ({ ...identity }));
    expect((await signIn()).cb.status).toBe(403);
  });
});

describe("fleet mcp kill switch", () => {
  it("answers 503 while the flag file exists, resumes when removed", async () => {
    expect((await toolsList()).status).toBe(401);
    fs.writeFileSync(cfg.disabledFile, "x");
    expect((await toolsList()).status).toBe(503);
    fs.rmSync(cfg.disabledFile);
    expect((await toolsList()).status).toBe(401);
  });
  it("fails closed when the flag cannot be read", () => {
    fs.writeFileSync(path.join(dir, "plain"), "x");
    expect(isDisabled(path.join(dir, "plain", "mcp.disabled"))).toBe(true); // ENOTDIR, not ENOENT
    expect(isDisabled(path.join(dir, "absent"))).toBe(false);
  });
  it("trips itself after repeated denied events that need the owner's own login", async () => {
    cfg.tripAfter = 3;
    expect((await signIn()).cb.status).toBe(302); // pins the owner's sub
    identity = { email: "owner@example.com", emailVerified: true, sub: "g-other" };
    for (let i = 0; i < 3; i++) await signIn();
    expect(fs.existsSync(cfg.disabledFile)).toBe(true);
  });
  it("foreign Google accounts are refused but cannot trip it", async () => {
    cfg.tripAfter = 3;
    identity = { email: "stranger@example.com", emailVerified: true, sub: "g-2" };
    for (let i = 0; i < 6; i++) expect((await signIn()).cb.status).toBe(403);
    expect(fs.existsSync(cfg.disabledFile)).toBe(false);
  });
});

describe("google identity", () => {
  const idToken = (claims: Record<string, unknown>) =>
    "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
  const ex = async (claims: Record<string, unknown>) => {
    const { googleExchangeFromEnv } = await import("./oauth.js");
    const f = (async () => new Response(JSON.stringify({ id_token: idToken(claims) }))) as unknown as typeof fetch;
    return googleExchangeFromEnv("gid", "secret", f)("c", "https://x/cb", "n");
  };
  const good = {
    aud: "gid",
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    email: "Owner@Example.com",
    email_verified: true,
    sub: "s",
  };
  it("reads the claims and lowercases the address", async () => {
    expect(await ex(good)).toMatchObject({ email: "owner@example.com", emailVerified: true, sub: "s" });
  });
  it("rejects a wrong audience, issuer or expired token", async () => {
    await expect(ex({ ...good, aud: "other" })).rejects.toThrow();
    await expect(ex({ ...good, iss: "https://evil.example" })).rejects.toThrow();
    await expect(ex({ ...good, exp: 1 })).rejects.toThrow();
  });
});

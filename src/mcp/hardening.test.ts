import { describe, it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createHandler, validateAuthConfig } from "./server.js";
import { loadTestConfig } from "./test-helpers.js";

const CB = "https://claude.ai/api/mcp/auth_callback";
async function run(identity: { email: string; sub: string }, wrongNonce: boolean, tries: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-h-"));
  let handler: http.RequestListener = () => undefined;
  const srv = http.createServer((q, s) => handler(q, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${(srv.address() as { port: number }).port}`;
  const cfg = {
    ...loadTestConfig({ OFFICE_TENANT_ROOT: dir } as NodeJS.ProcessEnv),
    allowedIps: ["127.0.0.1"],
    publicUrl: base,
    googleClientId: "gid",
    allowedEmails: ["owner@example.com"],
    stateFile: path.join(dir, "o.json"),
    disabledFile: path.join(dir, "off"),
    logFile: path.join(dir, "l.log"),
    tripAfter: 3,
  };
  handler = createHandler(cfg, fetch, async (_c, _r, nonce) => ({
    ...identity,
    emailVerified: true,
    nonce: wrongNonce ? "other" : nonce,
  }));
  const reg = (await (
    await fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "c", redirect_uris: [CB], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  for (let i = 0; i < tries; i++) {
    const ch = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: CB,
      code_challenge: ch,
      code_challenge_method: "S256",
      state: "s",
      resource: base + "/mcp",
    });
    const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    const html = await page.text();
    const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const c = await fetch(base + "/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: "txn=" + txn,
      redirect: "manual",
    });
    const st = new URL(c.headers.get("location")!).searchParams.get("state");
    await fetch(`${base}/oauth/google/callback?code=x&state=${st}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
  }
  const tripped = fs.existsSync(cfg.disabledFile);
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return tripped;
}

describe("fleet mcp hardening", () => {
  it("A: a stranger's Google account with a wrong nonce cannot trip the kill switch", async () => {
    expect(await run({ email: "stranger@example.org", sub: "s" }, true, 6)).toBe(false);
  });
  it("A: the owner's own account with a wrong nonce still counts", async () => {
    expect(await run({ email: "owner@example.com", sub: "g1" }, true, 3)).toBe(true);
  });
  it("E: the server refuses to start without public URL, Google client id and allowed e-mails", () => {
    const ok = { publicUrl: "https://x.example", googleClientId: "id", allowedEmails: ["a@b.c"] };
    expect(() => validateAuthConfig(ok as never)).not.toThrow();
    expect(() => validateAuthConfig({ ...ok, publicUrl: "" } as never)).toThrow(/PUBLIC_URL/);
    expect(() => validateAuthConfig({ ...ok, googleClientId: "" } as never)).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => validateAuthConfig({ ...ok, allowedEmails: [] } as never)).toThrow(/ALLOWED_EMAILS/);
  });
});

describe("per-person sign-in (profiles)", () => {
  async function session(allowed: string[], logins: Array<{ email: string; sub: string }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-p-"));
    let handler: http.RequestListener = () => undefined;
    const srv = http.createServer((q, s) => handler(q, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(srv.address() as { port: number }).port}`;
    const cfg = {
      ...loadTestConfig({ OFFICE_TENANT_ROOT: dir } as NodeJS.ProcessEnv),
      allowedIps: ["127.0.0.1"],
      publicUrl: base,
      googleClientId: "gid",
      allowedEmails: allowed,
      stateFile: path.join(dir, "o.json"),
      disabledFile: path.join(dir, "off"),
      logFile: path.join(dir, "l.log"),
    };
    let who = logins[0]!;
    handler = createHandler(cfg, fetch, async (_c, _r, nonce) => ({ ...who, emailVerified: true, nonce }));
    const results: number[] = [];
    for (const l of logins) {
      who = l;
      const reg = (await (
        await fetch(base + "/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "c", redirect_uris: [CB], token_endpoint_auth_method: "none" }),
        })
      ).json()) as { client_id: string };
      const ch = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("base64url");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: CB,
        code_challenge: ch,
        code_challenge_method: "S256",
        state: "s",
        resource: base + "/mcp",
      });
      const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
      const html = await page.text();
      const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
      const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const c = await fetch(base + "/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: "txn=" + txn,
        redirect: "manual",
      });
      const st = new URL(c.headers.get("location")!).searchParams.get("state");
      results.push(
        (
          await fetch(`${base}/oauth/google/callback?code=x&state=${st}`, {
            headers: { Cookie: cookie },
            redirect: "manual",
          })
        ).status,
      );
    }
    srv.close();
    const state = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"));
    fs.rmSync(dir, { recursive: true, force: true });
    return { results, state };
  }
  it("two different allowed people (own Google accounts) can both sign in; each e-mail has its own pin", async () => {
    const r = await session(
      ["a@x.y", "b@x.y"],
      [
        { email: "a@x.y", sub: "s-a" },
        { email: "b@x.y", sub: "s-b" },
      ],
    );
    expect(r.results).toEqual([302, 302]);
    expect(r.state.pins).toEqual({ "a@x.y": "s-a", "b@x.y": "s-b" });
  });
  it("the same e-mail with a different Google sub is refused (pin per e-mail)", async () => {
    const r = await session(
      ["a@x.y"],
      [
        { email: "a@x.y", sub: "s-1" },
        { email: "a@x.y", sub: "s-2" },
      ],
    );
    expect(r.results).toEqual([302, 403]);
  });
  it("grants remember the e-mail they were given to", async () => {
    const r = await session(["a@x.y"], [{ email: "a@x.y", sub: "s-1" }]);
    expect(r.results).toEqual([302]);
  });
});

describe("legacy single pin", () => {
  it("an owner address without its own pin must match the old pinnedSub; after that the other owner address pins freely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-l-"));
    const stateFile = path.join(dir, "o.json");
    fs.writeFileSync(stateFile, JSON.stringify({ pinnedSub: "legacy-sub", clients: {}, grants: {}, tokens: {} }));
    let handler: http.RequestListener = () => undefined;
    const srv = http.createServer((q, s) => handler(q, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(srv.address() as { port: number }).port}`;
    const cfg = {
      ...loadTestConfig({ OFFICE_TENANT_ROOT: dir } as NodeJS.ProcessEnv),
      allowedIps: ["127.0.0.1"],
      publicUrl: base,
      googleClientId: "gid",
      allowedEmails: ["o1@x.y", "o2@x.y", "m@x.y"],
      ownerEmails: ["o1@x.y", "o2@x.y"],
      stateFile,
      disabledFile: path.join(dir, "off"),
      logFile: path.join(dir, "l.log"),
    };
    let who = { email: "o1@x.y", sub: "other" };
    handler = createHandler(cfg, fetch, async (_c, _r, nonce) => ({ ...who, emailVerified: true, nonce }));
    const login = async (w: { email: string; sub: string }) => {
      who = w;
      const reg = (await (
        await fetch(base + "/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "c", redirect_uris: [CB], token_endpoint_auth_method: "none" }),
        })
      ).json()) as { client_id: string };
      const ch = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("base64url");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: CB,
        code_challenge: ch,
        code_challenge_method: "S256",
        state: "s",
        resource: base + "/mcp",
      });
      const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
      const html = await page.text();
      const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
      const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const c = await fetch(base + "/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: "txn=" + txn,
        redirect: "manual",
      });
      const st = new URL(c.headers.get("location")!).searchParams.get("state");
      return (
        await fetch(`${base}/oauth/google/callback?code=x&state=${st}`, {
          headers: { Cookie: cookie },
          redirect: "manual",
        })
      ).status;
    };
    expect(await login({ email: "o1@x.y", sub: "other" })).toBe(403); // not the legacy owner account
    expect(await login({ email: "m@x.y", sub: "member-sub" })).toBe(302); // a member is not bound by the owner's old pin
    expect(await login({ email: "o1@x.y", sub: "legacy-sub" })).toBe(302); // the legacy owner account claims it
    expect(await login({ email: "o2@x.y", sub: "second" })).toBe(302); // the legacy pin is used up: the other owner address pins freely
    expect(await login({ email: "o1@x.y", sub: "other" })).toBe(403); // and o1 is pinned now
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

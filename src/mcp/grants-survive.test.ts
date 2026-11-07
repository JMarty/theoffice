import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createHandler, type McpConfig } from "./server.js";
import { loadTestConfig } from "./test-helpers.js";

// 2026-11-07 incident: the owner's grant vanished from the state file and claude.ai signed him out. Root cause was a one-off hand-edit of
// mcp-oauth.json (it dropped every e-mail-less grant), not the server. These tests pin the rules that make such an edit unnecessary:
// the server never deletes a grant, an allow-list change only blocks at verify time, and a retried refresh must not sign the owner out.
const CB = "https://claude.ai/api/mcp/auth_callback";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const HEAD = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let dir: string, srv: http.Server | undefined, base: string, stateFile: string;

const client = { client_id: "c1", client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
const seed = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      pinnedSub: "legacy-sub",
      clients: { c1: client },
      grants: { legacy: { clientId: "c1", sub: "legacy-sub" }, member: { clientId: "c1", sub: "m-sub", email: "member@example.com" }, owner: { clientId: "c1", sub: "o-sub", email: "owner@example.com" } },
      tokens: {
        [sha("acc-legacy")]: { kind: "access", grant: "legacy", exp: nowS() + 3600 },
        [sha("acc-member")]: { kind: "access", grant: "member", exp: nowS() + 3600 },
        [sha("rt-owner")]: { kind: "refresh", grant: "owner", exp: nowS() + 100000 },
      },
      ...extra,
    }),
  );

async function start(allowed: string[]) {
  const cfg: McpConfig = {
    ...loadTestConfig({ OFFICE_TENANT_ROOT: dir } as NodeJS.ProcessEnv),
    allowedIps: ["127.0.0.1"],
    publicUrl: "http://localhost",
    googleClientId: "gid",
    allowedEmails: allowed,
    stateFile,
    disabledFile: path.join(dir, "mcp.disabled"),
    logFile: path.join(dir, "calls.log"),
  };
  const h = createHandler(cfg, fetch, async () => ({ email: "x", emailVerified: true, sub: "x" }));
  srv = http.createServer((q, r) => h(q, r));
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(srv.address() as { port: number }).port}`;
}
const stop = () => new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
const tools = (t: string) => fetch(base + "/mcp", { method: "POST", headers: { ...HEAD, Authorization: "Bearer " + t }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
const refresh = (rt: string) => fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: "c1", refresh_token: rt }) });
const onDisk = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as { grants: Record<string, unknown>; tokens: Record<string, unknown> };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-grants-"));
  stateFile = path.join(dir, "oauth.json");
  seed();
});
afterEach(async () => {
  vi.useRealTimers();
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("grants survive restarts and profile edits", () => {
  it("an e-mail-less first-version grant keeps working across restarts and allow-list edits", async () => {
    await start(["owner@example.com"]);
    expect((await tools("acc-legacy")).status).toBe(200);
    await stop();
    await start(["someone-else@example.com"]); // restart + profiles edited: the first-version grant belongs to the owner and is not gated by the list
    expect((await tools("acc-legacy")).status).toBe(200);
  });

  it("taking an address off the list blocks it at verify time but deletes nothing, and adding it back restores it", async () => {
    await start(["owner@example.com"]); // member@ is not on the list
    expect((await tools("acc-member")).status).toBe(401);
    expect(Object.keys(onDisk().grants).sort()).toEqual(["legacy", "member", "owner"]);
    await stop();
    await start(["owner@example.com", "member@example.com"]);
    expect((await tools("acc-member")).status).toBe(200);
  });

  it("a state write by the server (a new client registering) keeps every existing grant and token", async () => {
    await start(["owner@example.com"]);
    const r = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    expect(r.status).toBe(201);
    const d = onDisk();
    expect(Object.keys(d.grants).sort()).toEqual(["legacy", "member", "owner"]);
    expect(Object.keys(d.tokens)).toHaveLength(3);
  });
});

describe("a retried refresh does not sign the owner out", () => {
  it("after a restart lost the first reply, one more rotation is allowed and a third use revokes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await start(["owner@example.com"]);
    expect((await refresh("rt-owner")).status).toBe(200);
    await stop();
    await start(["owner@example.com"]); // the in-memory reply is gone
    expect((await refresh("rt-owner")).status).toBe(200);
    expect((await refresh("rt-owner")).status).toBe(400);
  });

  it("reusing a refresh token inside the grace window rotates again and keeps the grant; after it, the grant is revoked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await start(["owner@example.com"]);
    const first = await refresh("rt-owner");
    expect(first.status).toBe(200);
    const a1 = ((await first.json()) as Record<string, string>).access_token!;
    const before = Object.keys(onDisk().tokens).length;
    let a2 = a1;
    for (let i = 0; i < 5; i++) {
      const retry = await refresh("rt-owner"); // claude.ai retries: the reply to the first call was lost
      expect(retry.status).toBe(200);
      a2 = ((await retry.json()) as Record<string, string>).access_token!;
      expect(a2).toBe(a1); // the same reply every time
    }
    expect(Object.keys(onDisk().tokens)).toHaveLength(before); // five retries mint no new chain
    expect((await tools(a1)).status).toBe(200);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await refresh("rt-owner")).status).toBe(400); // a real replay, long after: revoke the grant
    expect((await tools(a2)).status).toBe(401);
  });
});

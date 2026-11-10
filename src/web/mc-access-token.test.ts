import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createServer as netCreateServer } from "node:net";
import { request as httpRequest } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, _setJwksForTest } from "./server.js";
import { openDb, closeDb } from "../db/index.js";
import type { Jwks } from "./cf-access.js";

/** Mission Control behind Cloudflare Access: the owner's valid Access JWT, on a configured host only, returns the dashboard token so the UI skips the token prompt (2026-11-05). */
const TOKEN = "agent-bearer-token";
const TEAM = "team-test.cloudflareaccess.com";
const AUD = "aud-office-1";
const OWNER = "owner@example.com";
const HOST = "office.k-office.hu";

let priv: KeyObject, evilPriv: KeyObject, jwks: Jwks;
beforeAll(() => {
  const a = generateKeyPairSync("rsa", { modulusLength: 2048 });
  evilPriv = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  priv = a.privateKey;
  jwks = { keys: [{ ...(a.publicKey.export({ format: "jwk" }) as object), kid: "k1" } as Jwks["keys"][number]] };
});
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(over: Record<string, unknown> = {}, key: KeyObject = priv): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], email: OWNER, exp: now + 600, iat: now, ...over })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(key).toString("base64url")}`;
}
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = netCreateServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

describe("POST /mc/access-token", () => {
  let dir: string, stop: () => void, port: number;
  const start = async (tokenHosts?: string[]) => {
    dir = join(tmpdir(), "office-mcat-" + Math.random().toString(36).slice(2));
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", ".dashboard-token"), TOKEN);
    port = await freePort();
    openDb(join(dir, "t.db"));
    _setJwksForTest(async () => jwks);
    stop = startServer({
      mainAgentId: "main",
      web: { host: "127.0.0.1", port, cfAccess: { teamDomain: TEAM, audiences: [AUD], ownerEmail: OWNER, ...(tokenHosts ? { tokenHosts } : {}) } },
      paths: { dashboardTokenFile: join(dir, "store", ".dashboard-token"), storeDir: join(dir, "store") },
      owner: { timezone: "UTC", slackUserId: "UOWNER" },
      channel: { provider: "none" },
    } as never);
    await new Promise((r) => setTimeout(r, 100));
  };
  afterEach(() => { stop?.(); closeDb(); _setJwksForTest(null); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const call = (headers: Record<string, string>, method = "POST") => new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path: "/mc/access-token", method, headers }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers })); });
    r.on("error", reject); r.end();
  });

  it("the owner's Access JWT on the configured host gets the dashboard token (no-store)", async () => {
    await start([HOST]);
    const r = await call({ Host: HOST, "Cf-Access-Jwt-Assertion": jwt(), "Sec-Fetch-Site": "same-origin" });
    expect(r.status).toBe(200); expect(JSON.parse(r.body)).toEqual({ token: TOKEN }); expect(String(r.headers["cache-control"])).toMatch(/no-store/);
  });

  it("refused: another host (LAN, 127.0.0.1), no JWT, a bearer alone, a forged or other-audience/other-user JWT, a cross-site request, a GET", async () => {
    await start([HOST]);
    const ok = { Host: HOST, "Cf-Access-Jwt-Assertion": jwt(), "Sec-Fetch-Site": "same-origin" };
    expect((await call({ ...ok, Host: "c.kosztopulosz.hu" })).status).toBe(403);
    expect((await call({ ...ok, Host: `127.0.0.1:${port}` })).status).toBe(403);
    expect((await call({ Host: HOST, "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect((await call({ Host: HOST, Authorization: `Bearer ${TOKEN}`, "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect((await call({ ...ok, "Cf-Access-Jwt-Assertion": jwt({}, evilPriv) })).status).toBe(403);
    expect((await call({ ...ok, "Cf-Access-Jwt-Assertion": jwt({ aud: ["other"] }) })).status).toBe(403);
    expect((await call({ ...ok, "Cf-Access-Jwt-Assertion": jwt({ email: "agent@example.com" }) })).status).toBe(403);
    expect((await call({ ...ok, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await call(ok, "GET")).status).toBe(405);
  });

  it("off unless tokenHosts is configured (the default): even a valid owner JWT gets nothing", async () => {
    await start();
    expect((await call({ Host: HOST, "Cf-Access-Jwt-Assertion": jwt(), "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
  });
});

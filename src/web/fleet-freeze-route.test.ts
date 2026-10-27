import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createServer as netCreateServer } from "node:net";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, _setJwksForTest } from "./server.js";
import { openDb, closeDb } from "../db/index.js";
import type { Jwks } from "./cf-access.js";

const TOKEN = "agent-bearer-token";
const TEAM = "team-test.cloudflareaccess.com";
const AUD = "aud-office-1";
const OWNER = "owner@example.com";

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

describe("dashboard freeze / unfreeze routes", () => {
  let dir: string, stop: () => void, base: string;
  const frozenFile = () => join(dir, "store", "fleet-freeze.json");

  const start = async (cfAccess: boolean = true) => {
    dir = join(tmpdir(), "office-frz-route-" + Math.random().toString(36).slice(2));
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", ".dashboard-token"), TOKEN);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    openDb(join(dir, "t.db"));
    _setJwksForTest(async () => jwks);
    stop = startServer({
      mainAgentId: "main",
      web: { host: "127.0.0.1", port, ...(cfAccess ? { cfAccess: { teamDomain: TEAM, audiences: [AUD], ownerEmail: OWNER } } : {}) },
      paths: { dashboardTokenFile: join(dir, "store", ".dashboard-token"), storeDir: join(dir, "store") },
      owner: { timezone: "UTC", slackUserId: "UOWNER" },
      channel: { provider: "none" },
    } as never);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(frozenFile(), JSON.stringify({ reason: "test", by: "toby", at: 1 }));
  };
  afterEach(() => { stop?.(); closeDb(); _setJwksForTest(null); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const unfreeze = (headers: Record<string, string> = {}) => fetch(`${base}/api/fleet/unfreeze`, { method: "POST", headers });

  it("the owner's Cloudflare Access JWT thaws the fleet (no bearer needed)", async () => {
    await start();
    const r = await unfreeze({ "Cf-Access-Jwt-Assertion": jwt() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ frozen: false });
    expect(existsSync(frozenFile())).toBe(false);
  });

  it("a valid BEARER alone is refused with 403 and the fleet stays frozen (agents hold the bearer)", async () => {
    await start();
    const r = await unfreeze({ Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(403);
    expect(existsSync(frozenFile())).toBe(true);
  });

  it("no credentials, a forged signature, another person's JWT, a wrong audience and an expired token are all 403", async () => {
    await start();
    for (const h of [{}, { "Cf-Access-Jwt-Assertion": jwt({}, evilPriv) }, { "Cf-Access-Jwt-Assertion": jwt({ email: "agent@example.com" }) },
                     { "Cf-Access-Jwt-Assertion": jwt({ aud: ["other"] }) }, { "Cf-Access-Jwt-Assertion": jwt({ exp: 5 }) }, { "Cf-Access-Jwt-Assertion": "garbage" }]) {
      expect((await unfreeze(h)).status).toBe(403);
    }
    expect(existsSync(frozenFile())).toBe(true);
  });

  it("a forged owner JWT does not become valid because a bearer is attached too", async () => {
    await start();
    expect((await unfreeze({ Authorization: `Bearer ${TOKEN}`, "Cf-Access-Jwt-Assertion": jwt({}, evilPriv) })).status).toBe(403);
    expect(existsSync(frozenFile())).toBe(true);
  });

  it("with no cfAccess configured nothing can unfreeze through the dashboard", async () => {
    await start(false);
    expect((await unfreeze({ "Cf-Access-Jwt-Assertion": jwt() })).status).toBe(403);
    expect(existsSync(frozenFile())).toBe(true);
  });

  it("unfreeze-request needs the bearer, thaws NOTHING, and asks the owner once per 5 minutes", async () => {
    await start();
    const { getDb } = await import("../db/index.js");
    // owner Slack id is configured in this test config through the cfg object below
    const call = (auth = true) => fetch(`${base}/api/fleet/unfreeze-request`, { method: "POST", headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} });
    expect((await call(false)).status).toBe(401);
    const r1 = await (await call()).json();
    expect(r1).toEqual({ sent: true });
    expect(existsSync(frozenFile())).toBe(true); // asking is not thawing
    const rows = getDb().prepare(`SELECT text, channel FROM outbound_queue`).all() as { text: string; channel: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("UOWNER");
    expect(rows[0]!.text).toContain("unfreeze fleet");
    const r2 = await (await call()).json();
    expect(r2.sent).toBe(false); // rate limited
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM outbound_queue`).get() as { n: number }).n).toBe(1);
  });

  it("unfreeze-request says so when the fleet is not frozen and sends no DM", async () => {
    await start();
    rmSync(frozenFile());
    const { getDb } = await import("../db/index.js");
    const r = await (await fetch(`${base}/api/fleet/unfreeze-request`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(r).toMatchObject({ sent: false });
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM outbound_queue`).get() as { n: number }).n).toBe(0);
  });

  it("freeze still needs the bearer: any agent may freeze, nobody anonymous", async () => {
    await start();
    rmSync(frozenFile());
    expect((await fetch(`${base}/api/fleet/freeze`, { method: "POST", body: "{}" })).status).toBe(401);
    const r = await fetch(`${base}/api/fleet/freeze`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "X-Office-Agent": "toby" }, body: JSON.stringify({ reason: "loop" }) });
    expect(r.status).toBe(200);
    expect(existsSync(frozenFile())).toBe(true);
    const s = await (await fetch(`${base}/api/fleet/freeze`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(s).toMatchObject({ frozen: true, by: "toby", reason: "loop" });
  });
});

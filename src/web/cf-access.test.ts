import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign, createHmac, type KeyObject } from "node:crypto";
import { verifyAccessJwt, makeJwksProvider, type AccessConfig, type Jwks } from "./cf-access.js";

const TEAM = "team-test.cloudflareaccess.com";
const AUD = "aud-office-1";
const OWNER = "Owner@Example.com";
const NOW = 1_800_000_000;
const cfg: AccessConfig = { teamDomain: TEAM, audiences: [AUD, "aud-office-2"], ownerEmail: OWNER };

let pub: KeyObject, priv: KeyObject, otherPriv: KeyObject, jwks: Jwks;
beforeAll(() => {
  const a = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pub = a.publicKey; priv = a.privateKey; otherPriv = b.privateKey;
  jwks = { keys: [{ ...(pub.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" } as Jwks["keys"][number]] };
});

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function jwt(payload: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string; header?: Record<string, unknown> } = {}): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT", ...opts.header };
  const body = { iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, type: "app", ...payload };
  const input = `${b64(header)}.${b64(body)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(opts.key ?? priv).toString("base64url");
  return `${input}.${sig}`;
}
const verify = (t: string | undefined, o: { jwks?: Jwks | null; c?: AccessConfig } = {}) =>
  verifyAccessJwt(t, o.c ?? cfg, NOW * 1000, async () => (o.jwks === undefined ? jwks : o.jwks));

describe("verifyAccessJwt", () => {
  it("accepts a valid owner token (email compared case-insensitively) and returns the email", async () => {
    expect(await verify(jwt({}))).toEqual({ ok: true, email: "owner@example.com" });
  });

  it("rejects a missing, malformed or empty header", async () => {
    for (const t of [undefined, "", "abc", "a.b", "a.b.c.d", "....", "not.a.jwt"]) expect((await verify(t)).ok).toBe(false);
  });

  it("rejects a token signed by another key, or with a tampered payload", async () => {
    expect((await verify(jwt({}, { key: otherPriv }))).ok).toBe(false);
    const t = jwt({});
    const [h, , s] = t.split(".");
    const evil = `${h}.${b64({ iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", exp: NOW + 99999, type: "app" })}.${s}`;
    expect((await verify(evil)).ok).toBe(false);
  });

  it("rejects the algorithm-confusion and none attacks", async () => {
    expect((await verify(jwt({}, { alg: "none" }))).ok).toBe(false);
    const hs = `${b64({ alg: "HS256", kid: "k1" })}.${b64({ iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", exp: NOW + 600 })}`;
    const sig = createHmac("sha256", pub.export({ type: "spki", format: "pem" }) as string).update(hs).digest("base64url");
    expect((await verify(`${hs}.${sig}`)).ok).toBe(false);
    expect((await verify(`${b64({ alg: "none" })}.${b64({ email: "owner@example.com", exp: NOW + 600 })}.`)).ok).toBe(false);
  });

  it("rejects the wrong audience, issuer or email, and a non-owner who is otherwise valid", async () => {
    expect((await verify(jwt({ aud: ["someone-elses-app"] }))).ok).toBe(false);
    expect((await verify(jwt({ iss: "https://evil.cloudflareaccess.com" }))).ok).toBe(false);
    expect((await verify(jwt({ email: "agent@example.com" }))).ok).toBe(false);
    expect((await verify(jwt({ email: undefined }))).ok).toBe(false);
  });

  it("accepts an audience given as a string and either configured audience", async () => {
    expect((await verify(jwt({ aud: AUD }))).ok).toBe(true);
    expect((await verify(jwt({ aud: ["aud-office-2"] }))).ok).toBe(true);
  });

  it("rejects an expired token and one not yet valid", async () => {
    expect((await verify(jwt({ exp: NOW - 1 }))).ok).toBe(false);
    expect((await verify(jwt({ nbf: NOW + 3600 }))).ok).toBe(false);
  });

  it("an unknown key id or an unreachable key set fails closed", async () => {
    expect((await verify(jwt({}, { kid: "unknown" }))).ok).toBe(false);
    expect((await verify(jwt({}), { jwks: null })).ok).toBe(false);
    expect((await verify(jwt({}), { jwks: { keys: [] } })).ok).toBe(false);
  });

  it("an empty-string audience in the config never matches (blank entries are dropped)", async () => {
    expect((await verify(jwt({ aud: [""] }), { c: { teamDomain: TEAM, audiences: ["", AUD], ownerEmail: OWNER } })).ok).toBe(false);
    expect((await verify(jwt({}), { c: { teamDomain: TEAM, audiences: ["", AUD], ownerEmail: OWNER } })).ok).toBe(true);
    expect((await verify(jwt({}), { c: { teamDomain: TEAM, audiences: [""], ownerEmail: OWNER } })).ok).toBe(false);
  });

  it("an incomplete config rejects everything (secure default)", async () => {
    expect((await verify(jwt({}), { c: { teamDomain: "", audiences: [AUD], ownerEmail: OWNER } })).ok).toBe(false);
    expect((await verify(jwt({}), { c: { teamDomain: TEAM, audiences: [], ownerEmail: OWNER } })).ok).toBe(false);
    expect((await verify(jwt({}), { c: { teamDomain: TEAM, audiences: [AUD], ownerEmail: "" } })).ok).toBe(false);
  });

  it("the failure reason never contains the token", async () => {
    const t = jwt({ email: "agent@example.com" });
    expect(JSON.stringify(await verify(t))).not.toContain(t.split(".")[2]!);
  });
});

describe("makeJwksProvider", () => {
  const mkFetch = (log: string[], body: unknown = { keys: [{ kid: "k1" }] }, ok = true) =>
    (async (url: string) => { log.push(String(url)); if (!ok) throw new Error("down"); return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch;

  it("fetches the team certs once and serves the cache for an hour", async () => {
    const log: string[] = []; let t = 1_000_000;
    const get = makeJwksProvider("team.example", mkFetch(log), () => t);
    await get(false); await get(false); t += 30 * 60_000; await get(false);
    expect(log).toEqual(["https://team.example/cdn-cgi/access/certs"]);
    t += 40 * 60_000; await get(false);
    expect(log).toHaveLength(2);
  });

  it("a forced refresh (unknown key id) is rate-limited to once per 5 minutes, so a flood of bad tokens cannot hammer Cloudflare", async () => {
    const log: string[] = []; let t = 1_000_000;
    const get = makeJwksProvider("team.example", mkFetch(log), () => t);
    await get(false);
    await get(true); await get(true); await get(true);
    expect(log).toHaveLength(2); // initial + ONE forced
    t += 6 * 60_000; await get(true);
    expect(log).toHaveLength(3);
  });

  it("a failing fetch returns the stale copy, or null if there never was one", async () => {
    const log: string[] = []; let t = 1_000_000;
    let ok = true;
    const f = (async () => { if (!ok) throw new Error("down"); return new Response(JSON.stringify({ keys: [{ kid: "k1" }] }), { status: 200 }); }) as unknown as typeof fetch;
    const get = makeJwksProvider("team.example", f, () => t);
    expect(await get(false)).toEqual({ keys: [{ kid: "k1" }] });
    ok = false; t += 2 * 3600_000;
    expect(await get(false)).toEqual({ keys: [{ kid: "k1" }] }); // stale beats nothing
    const cold = makeJwksProvider("team.example", mkFetch(log, {}, false), () => t);
    expect(await cold(false)).toBeNull();
  });
});

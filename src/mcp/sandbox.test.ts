import { describe, it, expect } from "vitest";
import { sandboxUrl, sandboxCheck } from "./sandbox.js";

const B = "sbx.example.test";

describe("sandboxUrl: only https://<label>.sbx.example.test", () => {
  it("accepts the project host, a branch preview host, with path and query", () => {
    expect(sandboxUrl("https://sbx.example.test/api/dbcheck", B)?.hostname).toBe("sbx.example.test"); // main
    expect(sandboxUrl("https://abc123.sbx.example.test/", B)?.hostname).toBe("abc123.sbx.example.test");
    expect(sandboxUrl("https://feat-x.sbx.example.test/api/dbcheck?a=1", B)?.search).toBe("?a=1");
    expect(sandboxUrl("https://a.b.sbx.example.test/x", B)).not.toBeNull();
  });
  it("rejects every bypass", () => {
    for (const u of [
      "http://abc.sbx.example.test/", // not https
      "https://abc.sbx.example.test.evil.com/",
      "https://evilsbx.example.test/", // suffix without the dot
      "https://sbx.example.test.evil.com/",
      "https://evil.com/.sbx.example.test",
      "https://evil.com#.sbx.example.test",
      "https://evil.com?x=.sbx.example.test",
      "https://abc.sbx.example.test@evil.com/",
      "https://user:pw@abc.sbx.example.test/",
      "https://abc.sbx.example.test:8443/",
      "https://abc.sbx.example.test:443/",
      "https://ABC.SBX.EXAMPLE.TEST.evil.com/",
      "https://abc.sbx.example.test./",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "ftp://abc.sbx.example.test/",
      "//abc.sbx.example.test/",
      "abc.sbx.example.test",
      "https://abc.sbx.example.test\\@evil.com/",
      "https://abc.sbx.example.test%2f@evil.com/",
      "https://.sbx.example.test/",
      "",
      "not a url",
    ])
      expect(sandboxUrl(u, B), u).toBeNull();
  });
});

const fake = (status: number, body: string, seen: { url?: string; init?: RequestInit }[] = []) =>
  (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;

describe("sandboxUrl: the base host is configuration", () => {
  it("an empty, dotless or odd base allows nothing", () => {
    for (const b of ["", "localhost", "a b.test", "x.test/evil", "*.test"]) expect(sandboxUrl("https://abc.sbx.example.test/", b), b).toBeNull();
  });
  it("dots in the base are literal", () => {
    expect(sandboxUrl("https://abc.sbxXexample.test/", B)).toBeNull();
  });
});

describe("sandboxCheck", () => {
  const U = "https://abc.sbx.example.test/api/dbcheck";
  it("GET returns status and the first 2 KB only", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await sandboxCheck(fake(200, "x".repeat(5000), seen), B, U, "GET");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(2048);
      expect(r.truncated).toBe(true);
    }
    expect(seen[0]!.init?.redirect).toBe("manual");
    expect(seen[0]!.init?.method).toBe("GET");
    expect(seen[0]!.init?.body).toBeUndefined();
  });
  it("POST sends a tiny body; a body over 2 KB is refused before any request", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await sandboxCheck(fake(201, "ok", seen), B, U, "POST", '{"a":1}');
    expect(r.ok && r.status).toBe(201);
    expect(seen[0]!.init?.body).toBe('{"a":1}');
    const big = await sandboxCheck(fake(200, "x", seen), B, U, "POST", "y".repeat(2049));
    expect(big.ok).toBe(false);
    expect(seen.length).toBe(1);
  });
  it("other methods and a body on GET are refused", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    for (const m of ["PUT", "DELETE", "PATCH", "HEAD", "get"])
      expect((await sandboxCheck(fake(200, "x", seen), B, U, m)).ok, m).toBe(false);
    expect((await sandboxCheck(fake(200, "x", seen), B, U, "GET", "body")).ok).toBe(false);
    expect(seen.length).toBe(0);
  });
  it("a redirect is reported, never followed", async () => {
    const f = (async () =>
      new Response("", { status: 302, headers: { location: "https://evil.com/" } })) as unknown as typeof fetch;
    const r = await sandboxCheck(f, B, U, "GET");
    expect(r.ok && r.status).toBe(302);
    if (r.ok) expect(r.redirect).toBe("https://evil.com/");
  });
  it("a foreign url is refused without a request", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await sandboxCheck(fake(200, "x", seen), B, "https://evil.com/", "GET");
    expect(r.ok).toBe(false);
    expect(seen.length).toBe(0);
  });
  it("times out after 10 s and a network error comes back as text", async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await sandboxCheck(hang, B, U, "GET", undefined, 50);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    const boom = (async () => {
      throw new Error("dns");
    }) as unknown as typeof fetch;
    expect((await sandboxCheck(boom, B, U, "GET")).ok).toBe(false);
  });
});

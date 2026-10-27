import { describe, it, expect, afterEach } from "vitest";
import { createServer as netCreateServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";

const freePort = (): Promise<number> => new Promise((res, rej) => { const s = netCreateServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

describe("/mc without the trailing slash", () => {
  let dir: string, stop: () => void, base: string;
  afterEach(() => { stop?.(); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it("redirects /mc to /mc/ (302) instead of answering not found; /mc/ itself still serves", async () => {
    dir = join(tmpdir(), "office-mc-redirect-" + Math.random().toString(36).slice(2));
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", ".dashboard-token"), "t");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    stop = startServer({ web: { host: "127.0.0.1", port }, paths: { dashboardTokenFile: join(dir, "store", ".dashboard-token") }, owner: { timezone: "UTC" }, channel: { provider: "none" } } as never);
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${base}/mc`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/mc/");
    expect((await fetch(`${base}/mc/`, { redirect: "manual" })).status).toBe(200);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { createServer as netCreateServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { openDb, closeDb, getDb } from "../db/index.js";

const TOKEN = "agent-bearer-token";
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = netCreateServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

// 2026-11-11 captain review (bus 28878): no route returned ONE inbound row, so recovering the payload of 38752 needed Michael.
describe("GET /api/inbound/:id (read-only, one row)", () => {
  let dir: string, stop: () => void, base: string;
  const start = async () => {
    dir = join(tmpdir(), "office-inb-" + Math.random().toString(36).slice(2));
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", ".dashboard-token"), TOKEN);
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    openDb(join(dir, "t.db"));
    stop = startServer({ mainAgentId: "main", web: { host: "127.0.0.1", port }, paths: { dashboardTokenFile: join(dir, "store", ".dashboard-token"), storeDir: join(dir, "store") }, owner: { timezone: "UTC", slackUserId: "UOWNER" }, channel: { provider: "none" } } as never);
    await new Promise((r) => setTimeout(r, 100));
    getDb().prepare("INSERT INTO inbound_queue(agent_id, source, prompt, reply_channel, reply_user, status) VALUES('pete','channel',?,?,?,'delivered')").run("Tenerife budget: what is the total?", "D0M", "U0OWNER");
  };
  afterEach(() => { stop?.(); closeDb(); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
  const get = (id: number | string, auth = true) => fetch(`${base}/api/inbound/${id}`, { headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} });

  it("returns the whole row including the full prompt", async () => {
    await start();
    const r = await get(1); expect(r.status).toBe(200);
    const b = await r.json() as Record<string, unknown>;
    expect(b).toMatchObject({ id: 1, agent_id: "pete", source: "channel", status: "delivered", reply_channel: "D0M", reply_user: "U0OWNER", prompt: "Tenerife budget: what is the total?" });
  });
  it("404 for a missing id, 400 for a junk id, 401 without the bearer", async () => {
    await start();
    expect((await get(999)).status).toBe(404);
    expect((await get("abc")).status).toBe(400);
    expect((await get(1, false)).status).toBe(401);
  });
  it("is read-only: POST and DELETE on the same path change nothing", async () => {
    await start();
    for (const m of ["POST", "DELETE", "PATCH"]) expect([404, 405]).toContain((await fetch(`${base}/api/inbound/1`, { method: m, headers: { Authorization: `Bearer ${TOKEN}` } })).status);
    expect((getDb().prepare("SELECT COUNT(*) c FROM inbound_queue").get() as { c: number }).c).toBe(1);
  });
});

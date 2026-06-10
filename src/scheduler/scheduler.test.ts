import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { openDb, closeDb, getDb } from "../db/index.js";
import { listQueued } from "../queue/index.js";
import { fireDueTasks } from "./index.js";

let root: string;
let cfg: EngineConfig;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "office-sched-"));
  const tasksDir = join(root, "scheduled-tasks");
  mkdirSync(join(tasksDir, "every-minute"), { recursive: true });
  writeFileSync(
    join(tasksDir, "every-minute", "task-config.json"),
    JSON.stringify({ schedule: "* * * * *", agent: "main", type: "task", prompt: "check the books" })
  );
  mkdirSync(join(tasksDir, "disabled-task"), { recursive: true });
  writeFileSync(
    join(tasksDir, "disabled-task", "task-config.json"),
    JSON.stringify({ schedule: "* * * * *", agent: "main", enabled: false, prompt: "should not fire" })
  );
  openDb(join(root, "test.db"));
  cfg = {
    mainAgentId: "main",
    paths: {
      tenantRoot: root,
      storeDir: root,
      dbFile: join(root, "test.db"),
      agentsDir: join(root, "agents"),
      secretsDir: join(root, "secrets"),
      scheduledTasksDir: tasksDir,
      skillsDir: join(root, "skills"),
      vaultKeyFile: join(root, ".vault-key"),
      dashboardTokenFile: join(root, ".dashboard-token"),
    },
    web: { host: "127.0.0.1", port: 3430 },
    tmux: { socket: "test" },
    owner: { displayName: "Owner", locale: "en", timezone: "Europe/Budapest" },
    channel: { provider: "none" },
  };
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe("fireDueTasks", () => {
  const now = Date.parse("2026-06-09T06:00:00Z");

  it("fires an enabled every-minute task into the queue + records a run", () => {
    const fired = fireDueTasks(cfg, now);
    expect(fired).toBe(1); // disabled task excluded
    const queued = listQueued("main");
    expect(queued.some((q) => q.source === "scheduler" && q.prompt.includes("check the books"))).toBe(true);
    const runs = (getDb().prepare(`SELECT COUNT(*) AS n FROM task_runs`).get() as { n: number }).n;
    expect(runs).toBe(1);
  });

  it("does not double-fire within the same minute (dedup)", () => {
    const fired = fireDueTasks(cfg, now);
    expect(fired).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { openDb, closeDb, getDb } from "../db/index.js";
import { listQueued } from "../queue/index.js";
import { fireDueTasks, catchUpMissed, sweepUnfinished } from "./index.js";
import { lastOccurrenceBefore } from "./cron.js";

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
  mkdirSync(join(tasksDir, "daily-3am"), { recursive: true });
  writeFileSync(
    join(tasksDir, "daily-3am", "task-config.json"),
    JSON.stringify({ schedule: "0 3 * * *", agent: "main", type: "task", prompt: "daily 3am job" })
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
    owner: { displayName: "Owner", locale: "en", timezone: "Europe/Paris" },
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

describe("catchUpMissed (#16 — fire occurrences missed while the engine was down)", () => {
  const runsFor = (name: string) =>
    (getDb().prepare(`SELECT COUNT(*) n FROM task_runs WHERE name=?`).get(name) as { n: number }).n;
  const setLastTick = (ms: number) =>
    getDb().prepare(`INSERT INTO scheduler_state (k,v) VALUES ('last_tick', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(ms);

  it("returns 0 when there is no prior last_tick (first boot ever — nothing to catch up)", () => {
    getDb().prepare(`DELETE FROM scheduler_state WHERE k='last_tick'`).run();
    expect(catchUpMissed(cfg, Date.parse("2026-06-20T10:00:00Z"))).toBe(0);
  });

  it("fires the latest occurrence missed during the down-gap, exactly once (idempotent on re-run)", () => {
    const T = Date.parse("2026-06-20T08:00:00Z");
    setLastTick(T - 10 * 60000); // engine last alive 10 min ago
    const before = runsFor("every-minute");
    expect(catchUpMissed(cfg, T)).toBe(1); // the 07:59 occurrence was missed -> fired once
    expect(runsFor("every-minute")).toBe(before + 1);
    expect(catchUpMissed(cfg, T)).toBe(0); // now recorded in task_runs -> re-run does NOT re-fire
  });

  it("does NOT re-fire an occurrence the on-time path already handled (consults task_runs BEFORE firing)", () => {
    const T = Date.parse("2026-06-21T09:00:00Z");
    setLastTick(T - 5 * 60000);
    // simulate the latest missed occurrence having ALREADY fired on-time: record it in task_runs
    const occ = lastOccurrenceBefore("* * * * *", T - (T % 60000), cfg.owner.timezone)!;
    getDb().prepare(`INSERT INTO task_runs (name, agent, ts) VALUES ('every-minute','main',?)`).run(Math.floor(occ / 1000));
    expect(catchUpMissed(cfg, T)).toBe(0); // already handled -> no double-fire
  });

  it("6h CUTOFF: a daily task whose last occurrence is ~11h ago is NOT caught up (proves the bound)", () => {
    // T = 14:00 Paris; the daily 03:00 Paris job last ran 11h ago — beyond the 6h window. Even though
    // it falls after lastTick (engine was down 30h), it must NOT be caught up. The shipped every-minute test
    // only asserted <=1; this proves the cutoff specifically against a real daily schedule.
    const T = Date.parse("2026-06-22T12:00:00Z"); // 14:00 Europe/Paris
    setLastTick(T - 30 * 60 * 60 * 1000); // 30h ago, so the daily occurrence IS after lastTick...
    const before = runsFor("daily-3am");
    catchUpMissed(cfg, T);
    expect(runsFor("daily-3am")).toBe(before); // ...but it's >6h old -> bounded out, never fired
  });

  it("watermark guard (occ <= since): an occurrence at/before the cutoff is skipped, one just after fires", () => {
    const T = Date.parse("2026-06-25T10:00:00Z");
    // boundary: latest every-minute occurrence is T-1m. With lastTick = T-1m, since = T-1m, so occ == since -> skip.
    setLastTick(T - 1 * 60000);
    let b = runsFor("every-minute");
    catchUpMissed(cfg, T);
    expect(runsFor("every-minute")).toBe(b); // occ (T-1m) <= since (T-1m) -> not fired

    // one minute earlier watermark: lastTick = T-2m -> since = T-2m, occ (T-1m) > since -> fires once.
    getDb().prepare(`DELETE FROM task_runs WHERE name='every-minute' AND ts>=?`).run(Math.floor((T - 5 * 60000) / 1000));
    setLastTick(T - 2 * 60000);
    b = runsFor("every-minute");
    catchUpMissed(cfg, T);
    expect(runsFor("every-minute")).toBe(b + 1); // occ (T-1m) > since (T-2m) -> fired exactly once
  });
});

describe("task completion wiring", () => {
  const setLastTick = (ms: number) =>
    getDb().prepare(`INSERT INTO scheduler_state (k, v) VALUES ('last_tick', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(ms);
  it("catch-up: a run fired now for a 3h-old occurrence is NOT alarmed until alarmAfterMin after the FIRE (blocker: ageing from the occurrence alarmed it at once)", () => {
    const T = Date.parse("2026-06-22T04:00:00Z"); // owner tz is Paris: the 03:00 occurrence was 01:00Z, 3 h ago
    setLastTick(T - 5 * 3600_000);
    expect(catchUpMissed(cfg, T)).toBeGreaterThan(0);
    const row = getDb().prepare(`SELECT ts, fired_at FROM task_runs WHERE name='daily-3am' ORDER BY id DESC LIMIT 1`).get() as { ts: number; fired_at: number };
    expect(row.fired_at).toBeGreaterThan(row.ts + 3 * 3600 - 60); // occurrence time is hours older than the real fire time
    const msgs = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_messages`).get() as { n: number }).n;
    const before = msgs();
    expect(sweepUnfinished(cfg, Date.now() + 60_000)).toBe(0); // one minute after firing: nothing
    expect(msgs()).toBe(before);
  });

  it("a due sweep sends ONE digest message for several runs, and shadow mode (alarm:false) sends none", () => {
    const db = getDb();
    db.prepare(`DELETE FROM task_runs`).run();
    const old = Math.floor(Date.now() / 1000) - 3600;
    for (const n of ["a", "b", "c"]) db.prepare(`INSERT INTO task_runs (name, agent, ts, fired_at, expects_completion) VALUES (?, 'main', ?, ?, 1)`).run(n, old, old);
    const msgs = () => (db.prepare(`SELECT COUNT(*) AS n FROM agent_messages`).get() as { n: number }).n;
    const before = msgs();
    expect(sweepUnfinished({ ...cfg, taskCompletion: { alarm: false } }, Date.now())).toBe(0);
    expect(msgs()).toBe(before);
    expect(sweepUnfinished(cfg, Date.now())).toBe(3);
    expect(msgs()).toBe(before + 1);
    expect(sweepUnfinished(cfg, Date.now())).toBe(0); // each run alarms once
  });

  it("heartbeat runs get no run id in the prompt and never expect completion", () => {
    const tdir = join(root, "scheduled-tasks-hb");
    mkdirSync(join(tdir, "hb"), { recursive: true });
    writeFileSync(join(tdir, "hb", "task-config.json"), JSON.stringify({ schedule: "* * * * *", agent: "hbagent", type: "heartbeat", prompt: "silent check" }));
    const hbCfg = { ...cfg, paths: { ...cfg.paths, scheduledTasksDir: tdir } };
    expect(fireDueTasks(hbCfg, Date.parse("2026-06-23T10:00:00Z"))).toBe(1);
    const run = getDb().prepare(`SELECT inbound_id, expects_completion FROM task_runs WHERE name='hb'`).get() as { inbound_id: number; expects_completion: number };
    expect(run.expects_completion).toBe(0);
    const q = listQueued("hbagent").find((x) => x.id === run.inbound_id);
    expect(q?.prompt).toContain("silent check");
    expect(q?.prompt).not.toContain("/api/task-runs/");
  });

  const now = Date.parse("2026-06-10T07:00:00Z");

  it("injects the run id and the completion instruction into the fired prompt, and links the run to its queue row", () => {
    fireDueTasks(cfg, now);
    const run = getDb().prepare(`SELECT id, inbound_id, expects_completion FROM task_runs ORDER BY id DESC LIMIT 1`).get() as { id: number; inbound_id: number; expects_completion: number };
    expect(run.expects_completion).toBe(1);
    const q = listQueued("main").find((x) => x.id === run.inbound_id);
    expect(q?.prompt).toContain(`/api/task-runs/${run.id}/complete`);
  });

  it("a deduped fire leaves NO orphan run row", () => {
    const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM task_runs`).get() as { n: number }).n;
    fireDueTasks(cfg, now); // same minute again
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM task_runs`).get() as { n: number }).n).toBe(before);
  });

});

describe("quota guard wiring", () => {
  const T = Date.parse("2026-06-24T10:00:00Z");
  const hot = { source: "authoritative", fetchedAtMs: Date.now(), fiveHour: { usedPercent: 97, resetsAtMs: Date.now() + 3600_000 }, sevenDay: null };
  const mkCfg = (guard: EngineConfig["quotaGuard"]): EngineConfig => {
    const tdir = join(root, `scheduled-tasks-q-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tdir, "hb"), { recursive: true });
    mkdirSync(join(tdir, "report"), { recursive: true });
    mkdirSync(join(tdir, "chore"), { recursive: true });
    writeFileSync(join(tdir, "hb", "task-config.json"), JSON.stringify({ schedule: "* * * * *", agent: "qagent", type: "heartbeat", prompt: "silent check" }));
    writeFileSync(join(tdir, "report", "task-config.json"), JSON.stringify({ schedule: "* * * * *", agent: "qagent", type: "task", prompt: "report to owner" }));
    writeFileSync(join(tdir, "chore", "task-config.json"), JSON.stringify({ schedule: "* * * * *", agent: "qagent", type: "task", quota: "background", prompt: "background chore" }));
    return { ...cfg, paths: { ...cfg.paths, scheduledTasksDir: tdir }, quotaGuard: guard };
  };
  const firedNames = () => (getDb().prepare(`SELECT name FROM task_runs WHERE agent='qagent'`).all() as { name: string }[]).map((r) => r.name).sort();

  it("enforce + pressure: heartbeat and quota:background task are deferred, the owner report still fires, and no run row is left", async () => {
    const { setSnapshotForTest } = await import("../quota/guard.js");
    setSnapshotForTest(hot);
    getDb().prepare(`DELETE FROM task_runs WHERE agent='qagent'`).run();
    expect(fireDueTasks(mkCfg({ enabled: true, mode: "enforce" }), T)).toBe(1);
    expect(firedNames()).toEqual(["report"]);
  });

  it("shadow mode fires everything even under pressure", async () => {
    const { setSnapshotForTest } = await import("../quota/guard.js");
    setSnapshotForTest(hot);
    getDb().prepare(`DELETE FROM task_runs WHERE agent='qagent'`).run();
    getDb().prepare(`DELETE FROM inbound_queue WHERE agent_id='qagent'`).run();
    expect(fireDueTasks(mkCfg({ enabled: true }), T + 60_000)).toBe(3);
  });

  it("guard disabled (default) or no snapshot: everything fires", async () => {
    const { setSnapshotForTest } = await import("../quota/guard.js");
    setSnapshotForTest(null);
    getDb().prepare(`DELETE FROM task_runs WHERE agent='qagent'`).run();
    getDb().prepare(`DELETE FROM inbound_queue WHERE agent_id='qagent'`).run();
    expect(fireDueTasks(mkCfg({ enabled: true, mode: "enforce" }), T + 120_000)).toBe(3);
    setSnapshotForTest(hot);
    getDb().prepare(`DELETE FROM task_runs WHERE agent='qagent'`).run();
    getDb().prepare(`DELETE FROM inbound_queue WHERE agent_id='qagent'`).run();
    expect(fireDueTasks(mkCfg(undefined), T + 180_000)).toBe(3);
  });
});

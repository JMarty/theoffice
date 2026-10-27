import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { OUTCOMES, expectsCompletion, completeRun, completionInstruction, findUnfinished, markAlarmed, alarmText } from "./completion.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-completion-"));
  openDb(join(dir, "t.db"));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function addRun(name: string, ts: number, expects = 1): number {
  const r = getDb().prepare(`INSERT INTO task_runs (name, agent, ts, expects_completion) VALUES (?, 'main', ?, ?)`).run(name, ts, expects);
  return Number(r.lastInsertRowid);
}

describe("migration: task_runs completion columns", () => {
  it("adds completed_at, outcome, delivery, inbound_id, alarmed_at, expects_completion; old rows stay open with expects 0", () => {
    const cols = (getDb().prepare(`PRAGMA table_info(task_runs)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ["completed_at", "outcome", "delivery", "inbound_id", "alarmed_at", "expects_completion"]) expect(cols).toContain(c);
    getDb().prepare(`INSERT INTO task_runs (name, agent, ts) VALUES ('old', 'main', 1)`).run();
    const row = getDb().prepare(`SELECT completed_at, expects_completion FROM task_runs WHERE name='old'`).get() as { completed_at: number | null; expects_completion: number };
    expect(row.completed_at).toBeNull();
    expect(row.expects_completion).toBe(0); // a pre-migration row never raises an alarm
  });
});

describe("completeRun", () => {
  it("closes an open run with an outcome and a note", () => {
    const id = addRun("a", 100);
    expect(completeRun(getDb(), id, "done", "sent 3 mails")).toBe("ok");
    const r = getDb().prepare(`SELECT completed_at, outcome FROM task_runs WHERE id=?`).get(id) as { completed_at: number; outcome: string };
    expect(r.completed_at).toBeGreaterThan(0);
    expect(r.outcome).toBe("done: sent 3 mails");
  });

  it("is idempotent and a repeat does NOT overwrite the first outcome or time", () => {
    const id = addRun("a", 100);
    completeRun(getDb(), id, "done");
    const first = getDb().prepare(`SELECT completed_at, outcome FROM task_runs WHERE id=?`).get(id);
    getDb().prepare(`UPDATE task_runs SET completed_at = 5 WHERE id=?`).run(id); // distinguishable stamp
    expect(completeRun(getDb(), id, "failed", "second try")).toBe("already");
    const after = getDb().prepare(`SELECT completed_at, outcome FROM task_runs WHERE id=?`).get(id) as { completed_at: number; outcome: string };
    expect(after.completed_at).toBe(5);
    expect(after.outcome).toBe((first as { outcome: string }).outcome);
  });

  it("reports an unknown run id and rejects an unknown outcome without writing", () => {
    expect(completeRun(getDb(), 9999, "done")).toBe("missing");
    const id = addRun("a", 100);
    expect(completeRun(getDb(), id, "banana")).toBe("bad_outcome");
    expect((getDb().prepare(`SELECT completed_at FROM task_runs WHERE id=?`).get(id) as { completed_at: number | null }).completed_at).toBeNull();
    expect(OUTCOMES).toContain("nothing_to_report");
  });

  it("truncates a long note", () => {
    const id = addRun("a", 100);
    completeRun(getDb(), id, "done", "x".repeat(1000));
    const r = getDb().prepare(`SELECT outcome FROM task_runs WHERE id=?`).get(id) as { outcome: string };
    expect(r.outcome.length).toBeLessThanOrEqual(220);
  });
});

describe("findUnfinished (the watchdog sweep)", () => {
  const NOW = 100_000;
  it("returns only expecting, open, unalarmed runs older than the threshold", () => {
    const old = addRun("old-open", NOW - 40 * 60);
    addRun("fresh", NOW - 5 * 60);
    const done = addRun("done", NOW - 50 * 60); completeRun(getDb(), done, "done");
    const hb = addRun("heartbeat", NOW - 50 * 60, 0);
    const al = addRun("alarmed", NOW - 50 * 60); markAlarmed(getDb(), al, "delivered");
    const ids = findUnfinished(getDb(), NOW, 30, 10).map((r) => r.id);
    expect(ids).toEqual([old]);
    expect(ids).not.toContain(hb);
  });

  it("caps a sweep so a backlog cannot flood the main agent", () => {
    for (let i = 0; i < 12; i++) addRun(`t${i}`, NOW - 3600);
    expect(findUnfinished(getDb(), NOW, 30, 5)).toHaveLength(5);
  });

  it("an alarmed run is not returned again", () => {
    const id = addRun("x", NOW - 3600);
    markAlarmed(getDb(), id, "queued");
    expect(findUnfinished(getDb(), NOW, 30, 10)).toHaveLength(0);
    const r = getDb().prepare(`SELECT alarmed_at, delivery FROM task_runs WHERE id=?`).get(id) as { alarmed_at: number; delivery: string };
    expect(r.alarmed_at).toBeGreaterThan(0);
    expect(r.delivery).toBe("queued");
  });
});

describe("expectsCompletion", () => {
  it("tasks are alarmed when unfinished; heartbeats are silent checks and never are", () => {
    expect(expectsCompletion("task")).toBe(1);
    expect(expectsCompletion("heartbeat")).toBe(0);
  });
});

describe("text", () => {
  it("the instruction names the run id, the endpoint and every outcome, and has no em dash", () => {
    const t = completionInstruction(42);
    expect(t).toContain("#42");
    expect(t).toContain("/api/task-runs/42/complete");
    for (const o of OUTCOMES) expect(t).toContain(o);
    expect(t).not.toContain("—");
  });

  it("the alarm names the task, the age and how the message was delivered", () => {
    const t = alarmText({ id: 7, name: "daily-report", agent: "main", ts: 1000, delivery: "queued" }, 1000 + 45 * 60);
    expect(t).toContain("daily-report");
    expect(t).toContain("45 min");
    expect(t).toContain("queued");
    expect(t).not.toContain("—");
  });
});

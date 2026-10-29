import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { OUTCOMES, expectsCompletion, completeRun, completionInstruction, findUnfinished, markAlarmed, alarmDigest } from "./completion.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-completion-"));
  openDb(join(dir, "t.db"));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function addRun(name: string, firedAt: number, expects = 1, ts = firedAt): number {
  const r = getDb().prepare(`INSERT INTO task_runs (name, agent, ts, fired_at, expects_completion) VALUES (?, 'main', ?, ?, ?)`).run(name, ts, firedAt, expects);
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
  it("ages a run from its FIRE time: a catch-up run with an hours-old occurrence ts is not alarmed 30 s after firing", () => {
    const id = addRun("catchup", NOW - 30, 1, NOW - 4 * 3600); // occurrence 4 h ago, fired 30 s ago
    expect(findUnfinished(getDb(), NOW, 30, 10)).toHaveLength(0);
    expect(findUnfinished(getDb(), NOW + 31 * 60, 30, 10).map((r) => r.id)).toEqual([id]);
  });

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

  it("stale-run cap: a run fired more than alarmMaxAgeH ago is never swept, so enabling alarms after a shadow period does not digest the whole backlog", () => {
    addRun("three-days-old", NOW - 3 * 86400);
    const recent = addRun("recent", NOW - 3600);
    expect(findUnfinished(getDb(), NOW, 30, 10).map((r) => r.id)).toEqual([recent]); // default 12 h
    expect(findUnfinished(getDb(), NOW, 30, 10, 100)).toHaveLength(2); // the cap is a parameter
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

describe("alarm digest", () => {
  it("one message lists every run; a single run uses the singular head", () => {
    const rows = [1, 2, 3].map((n) => ({ id: n, name: `t${n}`, agent: "main", ts: 0, fired_at: 1000, delivery: n === 2 ? "queued" : "delivered" }));
    const t = alarmDigest(rows, 1000 + 40 * 60);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(t).toContain("3 scheduled tasks");
    expect(t).toContain("still queued");
    expect(alarmDigest([rows[0]], 1000 + 40 * 60)).toContain("A scheduled task fired");
    expect(t).not.toContain("\u2014");
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

});

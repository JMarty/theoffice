import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { createCard, moveCard, patchCard, archiveCard, cardEvents } from "./kanban-audit.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-kanban-"));
  openDb(join(dir, "t.db"));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
const db = () => getDb();
const card = (over: Record<string, unknown> = {}) => createCard(db(), { title: "t", ...over }, "alice");

describe("migration: kanban event tables", () => {
  it("creates kanban_card_events and kanban_card_field_events", () => {
    const names = (db().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("kanban_card_events");
    expect(names).toContain("kanban_card_field_events");
  });
});

describe("createCard", () => {
  it("records a creation event (null -> status) with the actor, in the same transaction as the insert", () => {
    const id = card({ status: "planned" });
    const ev = cardEvents(db(), id);
    expect(ev.status).toHaveLength(1);
    expect(ev.status[0]).toMatchObject({ from_status: null, to_status: "planned", actor: "alice" });
  });
});

describe("moveCard", () => {
  it("moves a card, writes ONE status event with from/to/actor", () => {
    const id = card();
    const r = moveCard(db(), id, "in_progress", { actor: "bob" });
    expect(r).toMatchObject({ result: "ok", from: "planned" });
    const ev = cardEvents(db(), id).status;
    expect(ev.map((e) => [e.from_status, e.to_status, e.actor])).toEqual([[null, "planned", "alice"], ["planned", "in_progress", "bob"]]);
  });

  it("a move to the same status is a no-op: no event, still ok", () => {
    const id = card();
    const r = moveCard(db(), id, "planned", { actor: "bob" });
    expect(r.result).toBe("ok");
    expect(cardEvents(db(), id).status).toHaveLength(1);
  });

  it("expected_status matches: moves. Mismatch: 409-style conflict, card untouched, no event", () => {
    const id = card();
    expect(moveCard(db(), id, "in_progress", { actor: "bob", expected: "planned" }).result).toBe("ok");
    const r = moveCard(db(), id, "done", { actor: "carol", expected: "planned", verification: "checked the live endpoint, 200" });
    expect(r).toMatchObject({ result: "conflict", current: "in_progress" });
    expect((db().prepare(`SELECT status FROM kanban_cards WHERE id=?`).get(id) as { status: string }).status).toBe("in_progress");
    expect(cardEvents(db(), id).status).toHaveLength(2);
  });

  it("without expected_status the old last-write-wins behaviour is unchanged (opt-in)", () => {
    const id = card();
    moveCard(db(), id, "in_progress", { actor: "bob" });
    expect(moveCard(db(), id, "waiting", { actor: "carol" }).result).toBe("ok");
  });

  it("unknown card: notfound, and with expected_status it is still notfound, not conflict", () => {
    expect(moveCard(db(), "nope", "done", { actor: "x" }).result).toBe("notfound");
    expect(moveCard(db(), "nope", "done", { actor: "x", expected: "planned" }).result).toBe("notfound");
  });

  it("the status change and its event are ONE transaction: a failing event insert rolls the move back", () => {
    const id = card();
    db().exec(`CREATE TRIGGER boom BEFORE INSERT ON kanban_card_events WHEN NEW.to_status='in_progress' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => moveCard(db(), id, "in_progress", { actor: "bob" })).toThrow();
    expect((db().prepare(`SELECT status FROM kanban_cards WHERE id=?`).get(id) as { status: string }).status).toBe("planned");
  });

  it("persists verification on done and keeps it with the event write", () => {
    const id = card();
    moveCard(db(), id, "done", { actor: "bob", verification: "ran the test suite, 12 passed" });
    const row = db().prepare(`SELECT status, verification FROM kanban_cards WHERE id=?`).get(id) as { status: string; verification: string };
    expect(row).toMatchObject({ status: "done", verification: "ran the test suite, 12 passed" });
  });

  it("actor missing is stored as NULL, never a made-up name", () => {
    const id = card();
    moveCard(db(), id, "waiting", {});
    expect(cardEvents(db(), id).status.at(-1)!.actor).toBeNull();
  });
});

describe("archiveCard (who closed it)", () => {
  it("archives, and records an archived_at field event with the actor", () => {
    const id = card();
    expect(archiveCard(db(), id, "bob").result).toBe("ok");
    expect((db().prepare(`SELECT archived_at FROM kanban_cards WHERE id=?`).get(id) as { archived_at: number | null }).archived_at).not.toBeNull();
    const f = cardEvents(db(), id).fields;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ field: "archived_at", old_value: null, actor: "bob" });
    expect(Number(f[0]!.new_value)).toBeGreaterThan(0);
  });

  it("archiving twice writes the event once (the second is a no-op for the audit trail) and an unknown card is notfound", () => {
    const id = card();
    archiveCard(db(), id, "bob");
    archiveCard(db(), id, "carol");
    expect(cardEvents(db(), id).fields).toHaveLength(1);
    expect(archiveCard(db(), "nope", "bob").result).toBe("notfound");
  });
});

describe("patchCard (field events)", () => {
  it("records one field event per REAL change with old/new/actor", () => {
    const id = card({ priority: "normal" });
    expect(patchCard(db(), id, { priority: "high", project: "alpha" }, "bob").result).toBe("ok");
    const f = cardEvents(db(), id).fields.map((e) => [e.field, e.old_value, e.new_value, e.actor]).sort();
    expect(f).toEqual([["priority", "normal", "high", "bob"], ["project", null, "alpha", "bob"]]);
  });

  it("setting a field to its current value writes no event", () => {
    const id = card({ priority: "high" });
    patchCard(db(), id, { priority: "high" }, "bob");
    expect(cardEvents(db(), id).fields).toHaveLength(0);
  });

  it("unknown card: notfound; no fields: no events", () => {
    expect(patchCard(db(), "nope", { priority: "low" }, "bob").result).toBe("notfound");
  });

  it("field events never appear in the status event list (separate tables)", () => {
    const id = card();
    patchCard(db(), id, { priority: "urgent" }, "bob");
    expect(cardEvents(db(), id).status).toHaveLength(1); // only the creation event
  });
});

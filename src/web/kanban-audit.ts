import { randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

/**
 * Kanban safety: every status move and every audited field change leaves a row saying who did it, written in the
 * SAME transaction as the change, and a move can be made conditional (expected_status) so two agents racing on one
 * card get a 409 instead of a silent last-write-wins. The actor is whatever the caller names (X-Office-Agent or body
 * `actor`): attribution by convention, not authentication.
 *
 * Status events and field events are separate tables on purpose: a reader of status transitions (stuck detector,
 * status age) must never mistake a priority change for one.
 */
export type MoveResult =
  | { result: "ok"; from: string; changed: boolean }
  | { result: "notfound" }
  | { result: "conflict"; current: string };

export interface CardFields {
  title: string;
  description?: string | null;
  status?: string;
  assignee?: string | null;
  priority?: string;
  project?: string | null;
  parentId?: string | null;
}

export function createCard(db: DB, f: CardFields, actor?: string | null): string {
  const id = randomBytes(4).toString("hex");
  const status = f.status ?? "planned";
  db.transaction(() => {
    db.prepare(
      `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, f.title, f.description ?? null, status, f.assignee ?? null, f.priority ?? "normal", f.project ?? null, f.parentId ?? null);
    db.prepare(`INSERT INTO kanban_card_events (card_id, from_status, to_status, actor) VALUES (?, NULL, ?, ?)`).run(id, status, actor ?? null);
  })();
  return id;
}

/** Move a card. `expected` makes it a compare-and-set: a different current status is a conflict and nothing is written. */
export function moveCard(db: DB, id: string, to: string, opts: { actor?: string | null; expected?: string | null; verification?: string | null }): MoveResult {
  return db.transaction((): MoveResult => {
    const cur = db.prepare(`SELECT status FROM kanban_cards WHERE id = ?`).get(id) as { status: string } | undefined;
    if (!cur) return { result: "notfound" };
    if (opts.expected != null && cur.status !== opts.expected) return { result: "conflict", current: cur.status };
    if (opts.verification) {
      db.prepare(`UPDATE kanban_cards SET status = ?, verification = ?, updated_at = unixepoch() WHERE id = ?`).run(to, opts.verification, id);
    } else {
      db.prepare(`UPDATE kanban_cards SET status = ?, updated_at = unixepoch() WHERE id = ?`).run(to, id);
    }
    const changed = cur.status !== to;
    if (changed) db.prepare(`INSERT INTO kanban_card_events (card_id, from_status, to_status, actor) VALUES (?, ?, ?, ?)`).run(id, cur.status, to, opts.actor ?? null);
    return { result: "ok", from: cur.status, changed };
  })();
}

const AUDITED = ["priority", "project"] as const;
export type PatchFields = Partial<Record<(typeof AUDITED)[number], string | null>>;

/** Update the audited metadata fields; one field event per field whose value really changed. */
export function patchCard(db: DB, id: string, fields: PatchFields, actor?: string | null): { result: "ok" | "notfound" } {
  return db.transaction((): { result: "ok" | "notfound" } => {
    const cur = db.prepare(`SELECT priority, project FROM kanban_cards WHERE id = ?`).get(id) as Record<string, string | null> | undefined;
    if (!cur) return { result: "notfound" };
    const keys = AUDITED.filter((k) => k in fields);
    if (keys.length) {
      db.prepare(`UPDATE kanban_cards SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = unixepoch() WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    }
    for (const k of keys) {
      const before = cur[k] ?? null, after = fields[k] ?? null;
      if (before !== after) db.prepare(`INSERT INTO kanban_card_field_events (card_id, field, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?)`).run(id, k, before, after, actor ?? null);
    }
    return { result: "ok" };
  })();
}

export interface StatusEvent { id: number; card_id: string; from_status: string | null; to_status: string; actor: string | null; created_at: number }
export interface FieldEvent { id: number; card_id: string; field: string; old_value: string | null; new_value: string | null; actor: string | null; created_at: number }

export function cardEvents(db: DB, id: string): { status: StatusEvent[]; fields: FieldEvent[] } {
  return {
    status: db.prepare(`SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY id`).all(id) as StatusEvent[],
    fields: db.prepare(`SELECT * FROM kanban_card_field_events WHERE card_id = ? ORDER BY id`).all(id) as FieldEvent[],
  };
}

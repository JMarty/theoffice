import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import {
  enqueueInbound,
  listQueued,
  markDelivering,
  markDelivered,
  markFailed,
  requeue,
  requeueNoPenalty,
  requeueStaleDelivering,
  enqueueOutbound,
  listOutboundQueued,
  markOutboundSent,
  markOutboundFailed,
} from "./index.js";

let dir: string;

function row(id: number) {
  return getDb().prepare(`SELECT status, attempts FROM inbound_queue WHERE id=?`).get(id) as {
    status: string;
    attempts: number;
  };
}
function outRow(id: number) {
  return getDb().prepare(`SELECT status, attempts FROM outbound_queue WHERE id=?`).get(id) as {
    status: string;
    attempts: number;
  };
}

beforeEach(() => {
  closeDb();
  dir = mkdtempSync(join(tmpdir(), "office-queue-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("inbound queue attempt math", () => {
  it("markDelivering flips to 'delivering' and charges exactly one attempt", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "hi" })!;
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    markDelivering(id);
    expect(row(id)).toEqual({ status: "delivering", attempts: 1 });
  });

  it("requeue returns to 'queued' WITHOUT touching attempts", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "hi" })!;
    markDelivering(id); // attempts -> 1
    requeue(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 1 });
  });

  it("requeueNoPenalty refunds the attempt and clamps at 0", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "hi" })!;
    markDelivering(id); // attempts -> 1
    requeueNoPenalty(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    // clamp: refunding again never goes negative
    requeueNoPenalty(id);
    expect(row(id).attempts).toBe(0);
  });

  it("markDelivered / markFailed are terminal", () => {
    const a = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    markDelivered(a);
    expect(row(a).status).toBe("delivered");
    const b = enqueueInbound({ agentId: "a", source: "manual", prompt: "y" })!;
    markFailed(b, "boom");
    expect(row(b).status).toBe("failed");
  });

  it("dedup_key suppresses a second enqueue for the same (agent, key)", () => {
    const first = enqueueInbound({ agentId: "a", source: "channel", prompt: "x", dedupKey: "k1" });
    const dup = enqueueInbound({ agentId: "a", source: "channel", prompt: "x again", dedupKey: "k1" });
    expect(first).toBeTypeOf("number");
    expect(dup).toBeUndefined();
  });
});

describe("requeueStaleDelivering — boot reaper", () => {
  it("rescues items orphaned in 'delivering', keeping the attempt charged", () => {
    const stuck = enqueueInbound({ agentId: "a", source: "manual", prompt: "stuck" })!;
    const ok = enqueueInbound({ agentId: "a", source: "manual", prompt: "queued" })!;
    markDelivering(stuck); // simulate a crash mid-turn: left 'delivering'
    expect(listQueued().map((i) => i.id)).toEqual([ok]); // the stuck one is invisible to the deliverer

    const n = requeueStaleDelivering();
    expect(n).toBe(1);
    expect(row(stuck)).toEqual({ status: "queued", attempts: 1 }); // back in play, attempt preserved
    expect(listQueued().map((i) => i.id).sort()).toEqual([ok, stuck].sort());
  });

  it("is a no-op (0 rows) when nothing is stuck", () => {
    enqueueInbound({ agentId: "a", source: "manual", prompt: "x" });
    expect(requeueStaleDelivering()).toBe(0);
  });
});

describe("outbound queue state machine", () => {
  it("markOutboundSent is terminal", () => {
    const id = enqueueOutbound("a", "C1", "hello");
    expect(outRow(id).status).toBe("queued");
    markOutboundSent(id);
    expect(outRow(id).status).toBe("sent");
  });

  it("markOutboundFailed retries (back to queued, attempts++) for 5 strikes, then fails on the 6th", () => {
    // The CASE checks the PRE-increment attempts, so it keeps requeuing while attempts<5 and flips to
    // 'failed' once a failure arrives at attempts>=5 (i.e. 5 retries, terminal on the 6th).
    const id = enqueueOutbound("a", "C1", "hello");
    for (let i = 1; i <= 5; i++) {
      markOutboundFailed(id, "transient");
      expect(outRow(id)).toEqual({ status: "queued", attempts: i });
    }
    markOutboundFailed(id, "still bad");
    expect(outRow(id)).toEqual({ status: "failed", attempts: 6 });
    // a failed row is no longer queued for sending
    expect(listOutboundQueued().map((o) => o.id)).not.toContain(id);
  });
});

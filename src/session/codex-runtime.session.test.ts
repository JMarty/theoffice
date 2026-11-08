import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pete "can never remember more than one exchange": every inbound was a fresh `codex exec`. These tests pin the
 * fix: one Codex thread per agent, resumed with `codex exec resume <id>`, a safety-net history preamble only when a
 * thread starts fresh, and a clean reset on a dead session / full context / turn cap.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}
let kids: FakeChild[] = [];
const spawnMock = vi.fn((..._a: unknown[]) => {
  const c = new FakeChild();
  kids.push(c);
  return c;
});
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
const q = { markDelivering: vi.fn(), markDelivered: vi.fn(), markFailed: vi.fn(), requeue: vi.fn(), requeueNoPenalty: vi.fn(), MAX_DELIVERY_ATTEMPTS: 5 };
vi.mock("../queue/index.js", () => q);
const history = vi.fn(() => [] as { direction: string; text: string }[]);
vi.mock("../memory/conversation.js", () => ({ recordInbound: vi.fn(), recentConversation: (...a: unknown[]) => history(...(a as [])) }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

const { deliverCodexPrompt, buildCodexArgs, MAX_SESSION_TURNS } = await import("./codex-runtime.js");

const cfg = { owner: { timezone: "UTC" }, paths: { tenantRoot: "/t" }, web: { port: 3430 } } as never;
let n = 0;
const mkAgent = () => ({ id: `sess-${++n}`, dir: mkdtempSync(join(tmpdir(), "cx-")) }) as { id: string; dir: string };
const item = (agentId: string, prompt: string) => ({ id: ++n, agent_id: agentId, source: "channel", prompt, reply_channel: "D1", attempts: 0 }) as never;
const argsOf = (i: number) => spawnMock.mock.calls[i][1] as string[];
const finishOk = (c: FakeChild, thread = "T-1") => {
  c.stdout.emit("data", Buffer.from(JSON.stringify({ type: "thread.started", thread_id: thread }) + "\n"));
  c.stdout.emit("data", Buffer.from(JSON.stringify({ type: "turn.completed" }) + "\n"));
  c.emit("close", 0);
};

beforeEach(() => {
  kids = [];
  spawnMock.mockClear();
  history.mockReset().mockReturnValue([]);
  for (const f of Object.values(q)) (f as { mockClear?: () => void }).mockClear?.();
});

describe("buildCodexArgs", () => {
  it("fresh run vs resume of a thread", () => {
    expect(buildCodexArgs(null, "hi")).toEqual(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "hi"]);
    expect(buildCodexArgs("T-9", "hi")).toEqual(["exec", "resume", "T-9", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "hi"]);
  });
});

describe("one Codex thread per agent", () => {
  it("a 3-turn conversation stays in ONE thread (turn 2 and 3 resume the thread turn 1 created)", () => {
    const a = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "my code word is BANANA"));
    finishOk(kids[0], "T-A");
    deliverCodexPrompt(cfg, a as never, item(a.id, "what was my code word?"));
    expect(argsOf(1).slice(0, 3)).toEqual(["exec", "resume", "T-A"]);
    finishOk(kids[1], "T-A");
    deliverCodexPrompt(cfg, a as never, item(a.id, "and again?"));
    expect(argsOf(2).slice(0, 3)).toEqual(["exec", "resume", "T-A"]);
    expect(argsOf(0)).not.toContain("resume");
  });

  it("history preamble only on a fresh thread, never on a resumed one", () => {
    history.mockReturnValue([{ direction: "in", text: "earlier question" }, { direction: "out", text: "earlier answer" }]);
    const a = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "first"));
    const p0 = argsOf(0).at(-1) as string;
    expect(p0).toContain("earlier question");
    expect(p0).toContain("earlier answer");
    finishOk(kids[0]);
    deliverCodexPrompt(cfg, a as never, item(a.id, "second"));
    expect(argsOf(1).at(-1) as string).not.toContain("earlier question");
  });

  it("threads are per agent", () => {
    const a = mkAgent();
    const b = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "x"));
    finishOk(kids[0], "T-A");
    deliverCodexPrompt(cfg, b as never, item(b.id, "y"));
    expect(argsOf(1)).not.toContain("resume");
  });

  it("a dead thread ('no rollout found') is dropped, the message is retried fresh without burning an attempt", () => {
    const a = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "x"));
    finishOk(kids[0], "T-A");
    deliverCodexPrompt(cfg, a as never, item(a.id, "y"));
    kids[1].stderr.emit("data", Buffer.from("Error: thread/resume failed: no rollout found for thread id T-A"));
    kids[1].emit("close", 1);
    expect(q.requeueNoPenalty).toHaveBeenCalledTimes(1);
    expect(existsSync(join(a.dir, ".codex-session.json"))).toBe(false);
    deliverCodexPrompt(cfg, a as never, item(a.id, "y again"));
    expect(argsOf(2)).not.toContain("resume");
  });

  it("a full context window starts a new thread next time", () => {
    const a = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "x"));
    finishOk(kids[0], "T-A");
    deliverCodexPrompt(cfg, a as never, item(a.id, "y"));
    kids[1].stderr.emit("data", Buffer.from("Error: Codex ran out of room in the model's context window."));
    kids[1].emit("close", 1);
    deliverCodexPrompt(cfg, a as never, item(a.id, "z"));
    expect(argsOf(2)).not.toContain("resume");
  });

  it("the turn cap rolls the thread over", () => {
    const a = mkAgent();
    writeFileSync(join(a.dir, ".codex-session.json"), JSON.stringify({ id: "T-OLD", turns: MAX_SESSION_TURNS, startedAt: 1 }));
    deliverCodexPrompt(cfg, a as never, item(a.id, "x"));
    expect(argsOf(0)).not.toContain("resume");
  });

  it("the session file records the thread id and counts turns", () => {
    const a = mkAgent();
    deliverCodexPrompt(cfg, a as never, item(a.id, "x"));
    finishOk(kids[0], "T-A");
    const s = JSON.parse(readFileSync(join(a.dir, ".codex-session.json"), "utf8"));
    expect(s.id).toBe("T-A");
    expect(s.turns).toBe(1);
  });
});

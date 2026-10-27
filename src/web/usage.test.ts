import { describe, it, expect } from "vitest";
import { computeUsage } from "./usage.js";

// Non-Claude runtimes (codex/gemini) keep no Claude transcripts, so usage is
// unmeasurable and must be reported as tracked:false (UI shows "n/a", not a
// misleading 0). Claude (and the default/unset runtime) stay tracked:true.
describe("computeUsage tracked flag", () => {
  const cutoff = 0; // "all" window — include everything

  it("marks gemini and codex agents untracked, claude/default tracked", () => {
    const agents: any[] = [
      { id: "alpha", dir: "/nonexistent/alpha", runtime: "claude" },
      { id: "beta", dir: "/nonexistent/beta", runtime: "gemini" },
      { id: "bob", dir: "/nonexistent/bob", runtime: "codex" },
      { id: "def", dir: "/nonexistent/def" }, // no runtime → defaults to claude
    ];
    const byId = Object.fromEntries(computeUsage(agents, cutoff).map((u) => [u.id, u]));

    expect(byId.alpha.tracked).toBe(true);
    expect(byId.def.tracked).toBe(true);
    expect(byId.beta.tracked).toBe(false);
    expect(byId.bob.tracked).toBe(false);
  });

  it("untracked agents report zeroed counters (no transcript reads)", () => {
    const [u] = computeUsage([{ id: "beta", dir: "/nonexistent/beta", runtime: "gemini" }] as any[], cutoff);
    expect(u).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, tracked: false });
  });
});

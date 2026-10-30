import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRotation, swapCredentials, ROTATION_DEFAULTS } from "./rotation.js";
import type { QuotaSnapshot } from "./gate.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const snap = (p: number | null, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  source: "authoritative", fetchedAtMs: NOW - 60_000, fiveHour: p === null ? null : { usedPercent: p, resetsAtMs: NOW + 3600_000 }, sevenDay: null, ...over,
});
const decide = (plans: { id: string; snapshot: QuotaSnapshot | null }[], activeId = "a", lastSwitchMs: number | null = null) =>
  decideRotation({ activeId, plans, lastSwitchMs, nowMs: NOW, config: ROTATION_DEFAULTS });

describe("decideRotation", () => {
  it("stays while the active plan is below the rotate threshold", () => {
    expect(decide([{ id: "a", snapshot: snap(90) }, { id: "b", snapshot: snap(5) }]).action).toBe("stay");
  });

  it("rotates to the plan with the most headroom once the active plan is spent", () => {
    const d = decide([{ id: "a", snapshot: snap(98) }, { id: "b", snapshot: snap(40) }, { id: "c", snapshot: snap(10) }]);
    expect(d).toMatchObject({ action: "rotate", to: "c" });
  });

  it("never rotates to a plan without fresh authoritative data, or one that is itself nearly spent", () => {
    expect(decide([{ id: "a", snapshot: snap(99) }, { id: "b", snapshot: null }]).action).toBe("stay");
    expect(decide([{ id: "a", snapshot: snap(99) }, { id: "b", snapshot: snap(5, { fetchedAtMs: 0 }) }]).action).toBe("stay");
    expect(decide([{ id: "a", snapshot: snap(99) }, { id: "b", snapshot: snap(85) }]).action).toBe("stay");
  });

  it("FAIL SAFE: an unknown active plan never triggers a rotation", () => {
    expect(decide([{ id: "a", snapshot: null }, { id: "b", snapshot: snap(1) }]).action).toBe("stay");
    expect(decide([{ id: "a", snapshot: snap(99, { fetchedAtMs: 0 }) }, { id: "b", snapshot: snap(1) }]).action).toBe("stay");
  });

  it("holds after a switch so two spent plans cannot flap", () => {
    expect(decide([{ id: "a", snapshot: snap(99) }, { id: "b", snapshot: snap(1) }], "a", NOW - 10 * 60_000).action).toBe("stay");
    expect(decide([{ id: "a", snapshot: snap(99) }, { id: "b", snapshot: snap(1) }], "a", NOW - 61 * 60_000).action).toBe("rotate");
  });

  it("a single plan has nowhere to go", () => {
    expect(decide([{ id: "a", snapshot: snap(100) }]).action).toBe("stay");
  });
});

describe("swapCredentials", () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "office-swap-"));
    const cred = (t: string) => JSON.stringify({ claudeAiOauth: { accessToken: t, refreshToken: `r-${t}` } });
    const live = join(d, "live.json"), a = join(d, "a.json"), b = join(d, "b.json");
    writeFileSync(live, cred("live-A-fresh")); writeFileSync(a, cred("A-old")); writeFileSync(b, cred("B"));
    return { d, live, a, b };
  };

  it("saves the outgoing plan's CURRENT tokens back to its file, then installs the incoming plan, mode 0600", () => {
    const { d, live, a, b } = mk();
    try {
      swapCredentials({ liveFile: live, outgoingFile: a, incomingFile: b });
      expect(JSON.parse(readFileSync(a, "utf8")).claudeAiOauth.accessToken).toBe("live-A-fresh"); // A's refreshed tokens preserved
      expect(JSON.parse(readFileSync(live, "utf8")).claudeAiOauth.accessToken).toBe("B");
      expect(statSync(live).mode & 0o777).toBe(0o600);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses an incoming file that is not a credentials file and leaves everything as it was", () => {
    const { d, live, a, b } = mk();
    try {
      writeFileSync(b, "{{ not json");
      expect(() => swapCredentials({ liveFile: live, outgoingFile: a, incomingFile: b })).toThrow();
      expect(JSON.parse(readFileSync(live, "utf8")).claudeAiOauth.accessToken).toBe("live-A-fresh");
      expect(JSON.parse(readFileSync(a, "utf8")).claudeAiOauth.accessToken).toBe("A-old");
      expect(existsSync(live + ".tmp")).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

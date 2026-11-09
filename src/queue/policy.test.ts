import { describe, it, expect } from "vitest";
import { MAX_DELIVERY_ATTEMPTS } from "./index.js";
import {
  shouldEscalateDroppedOwnerItem,
  queueSourceRank,
  isStaleDroppableHeartbeat,
  ownerDropAlarmText,
  ownerStallAlarmText,
  permissionPromptBusText,
  permissionPromptDecider,
} from "./policy.js";

describe("shouldEscalateDroppedOwnerItem", () => {
  it("only the owner channel escalates; every other source fails quietly", () => {
    expect(shouldEscalateDroppedOwnerItem("channel")).toBe(true);
    for (const s of ["scheduler", "bus", "manual", "system"]) {
      expect(shouldEscalateDroppedOwnerItem(s)).toBe(false);
    }
  });
});

describe("queueSourceRank", () => {
  it("owner channel outranks everything else", () => {
    expect(queueSourceRank("channel")).toBe(0);
    for (const s of ["scheduler", "bus", "manual", "system"]) {
      expect(queueSourceRank(s)).toBe(1);
    }
  });
});

describe("isStaleDroppableHeartbeat", () => {
  const MAX = 2 * 60 * 60;
  it("drops a scheduler row older than the threshold", () => {
    expect(isStaleDroppableHeartbeat("scheduler", MAX + 1, MAX)).toBe(true);
  });
  it("keeps a scheduler row at or under the threshold", () => {
    expect(isStaleDroppableHeartbeat("scheduler", MAX, MAX)).toBe(false);
    expect(isStaleDroppableHeartbeat("scheduler", 10, MAX)).toBe(false);
  });
  it("NEVER drops owner/bus/manual/system however old", () => {
    for (const s of ["channel", "bus", "manual", "system"]) {
      expect(isStaleDroppableHeartbeat(s, 10 * MAX, MAX)).toBe(false);
    }
  });
  it("maxAgeSec <= 0 disables dropping", () => {
    expect(isStaleDroppableHeartbeat("scheduler", 10 * MAX, 0)).toBe(false);
    expect(isStaleDroppableHeartbeat("scheduler", 10 * MAX, -1)).toBe(false);
  });
});

describe("ownerDropAlarmText", () => {
  it("names the agent, the reason and the attempt budget, and quotes a preview", () => {
    const txt = ownerDropAlarmText("marveen", "dirty-pane", "No answer from the reviewer for 30 minutes");
    expect(txt).toContain("*marveen*");
    expect(txt).toContain("dirty-pane");
    expect(txt).toContain(String(MAX_DELIVERY_ATTEMPTS));
    expect(txt).toContain("re-send");
    expect(txt).toContain("No answer from the reviewer for 30 minutes");
  });
  it("flattens whitespace and truncates a long message with an ellipsis", () => {
    const long = "word ".repeat(100).trim(); // 500 chars, all one line after flattening
    const txt = ownerDropAlarmText("cfo", "submit-give-up", long);
    expect(txt).toContain("…");
    expect(txt).not.toContain("\n\n"); // preview is a single quoted line
    // preview capped at 140 chars of payload
    const previewLine = txt.split("\n").find((l) => l.startsWith("> "))!;
    expect(previewLine.length).toBeLessThanOrEqual(2 + 140 + 1);
  });
});

describe("ownerStallAlarmText — the queued-but-stuck case, worded honestly", () => {
  it("says 'not yet delivered / may be stuck', names the agent and minutes, quotes a preview", () => {
    const txt = ownerStallAlarmText("marveen", 16, "Status update please?");
    expect(txt).toContain("*marveen*");
    expect(txt).toContain("16 min");
    expect(txt).toContain("queued but not");
    expect(txt).toMatch(/stuck|not yet/i);
    expect(txt).not.toMatch(/dropped|could not deliver/i); // NOT a confirmed drop — it may still land
    expect(txt).toContain("Status update please?");
  });
});

describe("permission prompt routing (owner rule 2026-11-02: decided by marveen or darryl, never the owner)", () => {
  it("goes to marveen, or to darryl when the frozen agent IS marveen", () => {
    expect(permissionPromptDecider("cfo")).toBe("marveen");
    expect(permissionPromptDecider("darryl")).toBe("marveen");
    expect(permissionPromptDecider("marveen")).toBe("darryl");
  });
  it("names the agent, says it was left untouched, gives the read command and the prompt, and drops long opaque strings", () => {
    const txt = permissionPromptBusText("cfo", "theoffice", "agent-cfo", "Do you want to proceed?\nexport TOKEN=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    expect(txt).toContain("PERMISSION PROMPT: cfo");
    expect(txt).toMatch(/did NOT touch/i);
    expect(txt).toContain("tmux -L theoffice capture-pane");
    expect(txt).toContain("Do you want to proceed?");
    expect(txt).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    expect(txt).toContain("[long string removed]");
  });
});

import { describe, it, expect } from "vitest";
import {
  detectPaneState,
  isReadyForPrompt,
  detectsThinkingBlockError,
  shouldRetrySubmit,
  decideSubmitFollowup,
  liveInputBox,
} from "./pane-state.js";

const SEP = "─".repeat(40);
const FOOTER = "  bypass permissions on (shift+tab to cycle)";
const FOOTER_SHELLS = "  bypass permissions on · 1 shell · ↓ to manage";

function pane(...lines: string[]): string {
  return lines.join("\n");
}

describe("detectPaneState", () => {
  it("empty / blank -> unknown", () => {
    expect(detectPaneState("")).toBe("unknown");
    expect(detectPaneState("   \n  ")).toBe("unknown");
  });

  it("no idle footer -> unknown", () => {
    expect(detectPaneState(pane("just some scrollback", "no footer here"))).toBe("unknown");
  });

  it("clean idle box -> idle", () => {
    expect(detectPaneState(pane("assistant reply text", SEP, "❯ ", SEP, FOOTER))).toBe("idle");
    expect(detectPaneState(pane("reply", SEP, "❯ ", SEP, FOOTER_SHELLS))).toBe("idle");
  });

  it("esc-to-interrupt anywhere -> busy", () => {
    expect(detectPaneState(pane("✻ Working… (3s · ↓ 0.1k tokens · esc to interrupt)", SEP, "❯ ", SEP, FOOTER))).toBe("busy");
  });

  it("tokens-down-arrow counter -> busy (even if footer looks idle)", () => {
    expect(detectPaneState(pane("✻ Thinking… (52s · ↓ 2.6k tokens", SEP, "❯ ", SEP, FOOTER))).toBe("busy");
  });

  it("pending paste placeholder -> busy", () => {
    expect(detectPaneState(pane(SEP, "❯ [Pasted text #1 +812 chars]", SEP, FOOTER))).toBe("busy");
  });

  it("verbatim text parked in the input box -> typing", () => {
    expect(detectPaneState(pane(SEP, "❯ summarize the quarterly report", SEP, FOOTER))).toBe("typing");
  });

  it("parked ❯ in scrollback (not in live box) does NOT read as typing", () => {
    // a ❯ line ABOVE the live box, with a clean live box below -> idle
    const p = pane("❯ old historical command", "output", SEP, "❯ ", SEP, FOOTER);
    expect(detectPaneState(p)).toBe("idle");
  });

  it("wedged thinking-block error -> error", () => {
    const p = pane(
      "assistant turn",
      "⎿  API Error: 400 the thinking block cannot be modified (redacted_thinking)",
      SEP,
      "❯ ",
      SEP,
      FOOTER
    );
    expect(detectPaneState(p)).toBe("error");
  });

  it("quoted 'API Error' prose in a message is NOT an error state", () => {
    const p = pane("user asked about an API Error 400 earlier", SEP, "❯ ", SEP, FOOTER);
    expect(detectPaneState(p)).toBe("idle");
    expect(detectsThinkingBlockError(p)).toBe(false);
  });
});

describe("isReadyForPrompt", () => {
  it("only idle is ready", () => {
    expect(isReadyForPrompt(pane(SEP, "❯ ", SEP, FOOTER))).toBe(true);
    expect(isReadyForPrompt(pane(SEP, "❯ parked text here", SEP, FOOTER))).toBe(false);
    expect(isReadyForPrompt(pane("esc to interrupt"))).toBe(false);
  });
});

describe("liveInputBox", () => {
  it("returns inner box content, null when no live box", () => {
    expect(liveInputBox(pane(SEP, "❯ hello", SEP, FOOTER))).toBe("❯ hello");
    expect(liveInputBox(pane("no footer"))).toBeNull();
  });
});

describe("shouldRetrySubmit / decideSubmitFollowup", () => {
  const payload = "please summarize the quarterly report now";

  it("placeholder parked -> retry", () => {
    const p = pane(SEP, "❯ [Pasted text #2 +900 chars]", SEP, FOOTER);
    expect(shouldRetrySubmit(p, "")).toBe(true);
  });

  it("verbatim payload parked -> retry", () => {
    const p = pane(SEP, `❯ ${payload}`, SEP, FOOTER);
    expect(shouldRetrySubmit(p, payload)).toBe(true);
  });

  it("clean idle box -> no retry", () => {
    expect(shouldRetrySubmit(pane(SEP, "❯ ", SEP, FOOTER), payload)).toBe(false);
  });

  it("busy pane -> no retry", () => {
    expect(shouldRetrySubmit(pane("esc to interrupt"), payload)).toBe(false);
  });

  it("decideSubmitFollowup branches", () => {
    const stuck = pane(SEP, `❯ ${payload}`, SEP, FOOTER);
    const clean = pane(SEP, "❯ ", SEP, FOOTER);
    expect(decideSubmitFollowup(null, payload, 0, 4)).toBe("give-up");
    expect(decideSubmitFollowup(clean, payload, 0, 4)).toBe("done");
    expect(decideSubmitFollowup(stuck, payload, 0, 4)).toBe("retry-enter");
    expect(decideSubmitFollowup(stuck, payload, 4, 4)).toBe("give-up");
  });
});

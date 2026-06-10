import { describe, it, expect } from "vitest";
import { parseInbound } from "./slack-ingest.js";

describe("parseInbound", () => {
  const dm = { type: "message", channel_type: "im", channel: "D123", user: "U_owner", text: "hey Charly", ts: "1.1" };

  it("accepts a real DM", () => {
    expect(parseInbound(dm, "U_charly")).toEqual({ text: "hey Charly", channel: "D123", user: "U_owner", ts: "1.1" });
  });

  it("rejects the agent's own echo", () => {
    expect(parseInbound({ ...dm, user: "U_charly" }, "U_charly")).toBeNull();
  });

  it("rejects bot messages", () => {
    expect(parseInbound({ ...dm, bot_id: "B1" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "bot_message" }, "U_charly")).toBeNull();
  });

  it("rejects edits / system subtypes", () => {
    expect(parseInbound({ ...dm, subtype: "message_changed" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "channel_join" }, "U_charly")).toBeNull();
  });

  it("rejects empty / non-message / malformed", () => {
    expect(parseInbound({ ...dm, text: "   " }, "U_charly")).toBeNull();
    expect(parseInbound({ type: "app_home_opened" }, "U_charly")).toBeNull();
    expect(parseInbound(null, "U_charly")).toBeNull();
    expect(parseInbound({ type: "message", text: "hi" }, "U_charly")).toBeNull(); // no channel/user/ts
  });

  it("trims text", () => {
    expect(parseInbound({ ...dm, text: "  spaced  " }, "U_charly")?.text).toBe("spaced");
  });
});

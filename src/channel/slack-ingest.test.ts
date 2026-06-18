import { describe, it, expect } from "vitest";
import { parseInbound } from "./slack-ingest.js";

describe("parseInbound", () => {
  const dm = { type: "message", channel_type: "im", channel: "D123", user: "U_owner", text: "hey Charly", ts: "1.1" };

  it("accepts a real DM", () => {
    expect(parseInbound(dm, "U_charly")).toEqual({ text: "hey Charly", channel: "D123", user: "U_owner", ts: "1.1", files: [] });
  });

  it("accepts a file upload (subtype file_share) with a caption", () => {
    const ev = {
      ...dm,
      subtype: "file_share",
      text: "look at this",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", url_private_download: "https://files.slack.com/F1/photo.png" }],
    };
    expect(parseInbound(ev, "U_charly")).toEqual({
      text: "look at this",
      channel: "D123",
      user: "U_owner",
      ts: "1.1",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/F1/photo.png" }],
    });
  });

  it("accepts a file upload with NO caption (empty text but files present)", () => {
    const ev = { ...dm, subtype: "file_share", text: "", files: [{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/F2/doc.pdf" }] };
    const out = parseInbound(ev, "U_charly");
    expect(out?.text).toBe("");
    expect(out?.files).toEqual([{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", urlPrivateDownload: "https://files.slack.com/F2/doc.pdf" }]);
  });

  it("rejects the agent's own echo", () => {
    expect(parseInbound({ ...dm, user: "U_charly" }, "U_charly")).toBeNull();
  });

  it("rejects bot messages", () => {
    expect(parseInbound({ ...dm, bot_id: "B1" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "bot_message" }, "U_charly")).toBeNull();
  });

  it("rejects a non-DM channel_type (DM-only enforced in code, not just the manifest)", () => {
    expect(parseInbound({ ...dm, channel_type: "channel" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, channel_type: "group" }, "U_charly")).toBeNull();
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

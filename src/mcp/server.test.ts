import { describe, it, expect } from "vitest";
import { isAllowedIp, clip, normalizeIp } from "./server.js";

describe("fleet mcp helpers", () => {
  it("allows only listed IPs, incl. IPv4-mapped", () => {
    const a = ["127.0.0.1", "10.0.0.2"];
    expect(isAllowedIp("127.0.0.1", a)).toBe(true);
    expect(isAllowedIp("::ffff:10.0.0.2", a)).toBe(true);
    expect(isAllowedIp("10.0.0.9", a)).toBe(false);
    expect(isAllowedIp(undefined, a)).toBe(false);
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
  it("clips long arguments", () => {
    expect(clip("a".repeat(300)).length).toBe(201);
    expect(clip({ a: 1 })).toBe('{"a":1}');
  });
});

import { describe, it, expect } from "vitest";
import { isAllowedSender } from "./access.js";

const OWNER = "U_owner";
const EXT = "U_ext";

describe("isAllowedSender", () => {
  it("owner is always allowed", () => {
    expect(isAllowedSender(OWNER, undefined, OWNER)).toBe(true);
    expect(isAllowedSender(OWNER, [EXT], OWNER)).toBe(true);
  });

  it("owner configured + no list -> owner-only (others denied)", () => {
    expect(isAllowedSender(EXT, undefined, OWNER)).toBe(false);
    expect(isAllowedSender(EXT, [], OWNER)).toBe(false);
  });

  it("explicit allowFrom lets the listed external in, blocks others", () => {
    expect(isAllowedSender(EXT, [EXT], OWNER)).toBe(true); // shared agent: external user allowed
    expect(isAllowedSender("U_random", [EXT], OWNER)).toBe(false);
  });

  it("no owner configured (setup mode) -> open", () => {
    expect(isAllowedSender("anyone", undefined, undefined)).toBe(true);
    expect(isAllowedSender("anyone", undefined, "")).toBe(true);
  });
});

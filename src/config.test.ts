import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, _resetConfigCache } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-cfg-"));
  process.env.OFFICE_TENANT_ROOT = dir; // empty dir -> no overrides.json, so platform defaults apply
  delete process.env.OFFICE_PORT;
  delete process.env.OFFICE_RL_MAX_FAILS;
  _resetConfigCache();
});
afterEach(() => {
  delete process.env.OFFICE_TENANT_ROOT;
  delete process.env.OFFICE_PORT;
  delete process.env.OFFICE_RL_MAX_FAILS;
  _resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("numeric env overrides are validated (numEnv)", () => {
  it("keeps the default port when OFFICE_PORT is non-numeric (no ephemeral bind)", () => {
    process.env.OFFICE_PORT = "3430x";
    _resetConfigCache();
    expect(loadConfig().web.port).toBe(3430);
  });

  it("applies a valid OFFICE_PORT", () => {
    process.env.OFFICE_PORT = "4000";
    _resetConfigCache();
    expect(loadConfig().web.port).toBe(4000);
  });

  it("rejects a non-positive port (0) and keeps the default", () => {
    process.env.OFFICE_PORT = "0";
    _resetConfigCache();
    expect(loadConfig().web.port).toBe(3430);
  });

  it("keeps the rate-limit default when OFFICE_RL_MAX_FAILS is garbage (limiter must NOT fail open)", () => {
    process.env.OFFICE_RL_MAX_FAILS = "five";
    _resetConfigCache();
    expect(loadConfig().web.rateLimit?.maxFails).toBe(5);
  });

  it("treats a whitespace value as invalid and keeps the default (no instant lockout)", () => {
    process.env.OFFICE_RL_MAX_FAILS = " ";
    _resetConfigCache();
    expect(loadConfig().web.rateLimit?.maxFails).toBe(5);
  });
});

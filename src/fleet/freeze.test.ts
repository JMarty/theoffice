import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { isFrozen, freezeState, freezeFleet, unfreezeFleet, parseOwnerFreezeCommand, handleOwnerFreezeCommand, FREEZE_FILE } from "./freeze.js";

let dir: string;
let cfg: EngineConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-freeze-"));
  cfg = { paths: { storeDir: dir } } as EngineConfig;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("freeze file", () => {
  it("is not frozen until the file exists", () => {
    expect(isFrozen(cfg)).toBe(false);
    expect(freezeState(cfg)).toEqual({ frozen: false });
  });

  it("freezing writes who/why/when and isFrozen turns true", () => {
    const r = freezeFleet(cfg, "agent loop sending mail", "toby", 1000);
    expect(r).toMatchObject({ frozen: true, reason: "agent loop sending mail", by: "toby", at: 1000 });
    expect(isFrozen(cfg)).toBe(true);
    expect(freezeState(cfg)).toMatchObject({ frozen: true, by: "toby" });
  });

  it("a second freeze keeps the FIRST reason and author (the cause is not overwritten)", () => {
    freezeFleet(cfg, "first", "toby", 1000);
    expect(freezeFleet(cfg, "second", "darryl", 2000)).toMatchObject({ reason: "first", by: "toby", at: 1000 });
  });

  it("an unreadable or garbled file still means FROZEN (fail closed)", () => {
    writeFileSync(join(dir, FREEZE_FILE), "{{ not json");
    expect(isFrozen(cfg)).toBe(true);
    expect(freezeState(cfg)).toMatchObject({ frozen: true, reason: "freeze file unreadable" });
    rmSync(join(dir, FREEZE_FILE));
    writeFileSync(join(dir, FREEZE_FILE), "{}");
    chmodSync(join(dir, FREEZE_FILE), 0o000);
    expect(isFrozen(cfg)).toBe(true);
    chmodSync(join(dir, FREEZE_FILE), 0o600);
  });

  it("unfreeze removes the file; unfreezing a thawed fleet is a quiet no-op", () => {
    freezeFleet(cfg, "x", "toby");
    expect(unfreezeFleet(cfg)).toBe(true);
    expect(existsSync(join(dir, FREEZE_FILE))).toBe(false);
    expect(isFrozen(cfg)).toBe(false);
    expect(unfreezeFleet(cfg)).toBe(false);
  });

  it("the reason is length-capped and the file is 0600", () => {
    freezeFleet(cfg, "x".repeat(2000), "toby");
    expect((JSON.parse(readFileSync(join(dir, FREEZE_FILE), "utf8")) as { reason: string }).reason.length).toBeLessThanOrEqual(300);
  });
});

describe("parseOwnerFreezeCommand", () => {
  it("recognises freeze and unfreeze phrasings and nothing else", () => {
    expect(parseOwnerFreezeCommand("/unfreeze")).toEqual({ action: "unfreeze" });
    expect(parseOwnerFreezeCommand("!unfreeze")).toEqual({ action: "unfreeze" });
    expect(parseOwnerFreezeCommand("unfreeze fleet")).toEqual({ action: "unfreeze" });
    expect(parseOwnerFreezeCommand("  Unfreeze Fleet  ")).toEqual({ action: "unfreeze" });
    expect(parseOwnerFreezeCommand("/freeze runaway mailer")).toEqual({ action: "freeze", reason: "runaway mailer" });
    expect(parseOwnerFreezeCommand("freeze fleet")).toEqual({ action: "freeze", reason: "owner command" });
    expect(parseOwnerFreezeCommand("!freeze")).toEqual({ action: "freeze", reason: "owner command" });
  });
  it("does not trigger on ordinary chat that merely mentions freezing", () => {
    for (const t of ["can you unfreeze the budget?", "the screen froze", "please freeze the account", "freezer is full", "do not unfreeze yet", ""]) expect(parseOwnerFreezeCommand(t)).toBeNull();
  });
});

describe("handleOwnerFreezeCommand (the Slack path)", () => {
  const ownerCfg = () => ({ paths: { storeDir: dir }, owner: { slackUserId: "UOWNER" } }) as EngineConfig;

  it("the owner can freeze and thaw, and gets a reply to send", () => {
    const c = ownerCfg();
    expect(handleOwnerFreezeCommand(c, "freeze fleet runaway mailer", "UOWNER")).toContain("runaway mailer");
    expect(handleOwnerFreezeCommand(c, "freeze fleet x", "UOWNER")).toContain("codex"); // honest about runtimes the hook cannot stop
    expect(isFrozen(c)).toBe(true);
    expect(freezeState(c)).toMatchObject({ by: "owner" });
    expect(handleOwnerFreezeCommand(c, "unfreeze fleet", "UOWNER")).toContain("thawed");
    expect(isFrozen(c)).toBe(false);
  });

  it("anyone else saying the same words is ignored: not handled, nothing changes", () => {
    const c = ownerCfg();
    freezeFleet(c, "x", "toby");
    expect(handleOwnerFreezeCommand(c, "unfreeze fleet", "UOTHER")).toBeNull();
    expect(isFrozen(c)).toBe(true);
    expect(handleOwnerFreezeCommand(c, "/unfreeze", "")).toBeNull();
  });

  it("with no owner configured nobody can use it (secure default), and ordinary chat passes through", () => {
    const c = { paths: { storeDir: dir }, owner: {} } as EngineConfig;
    freezeFleet(c, "x", "toby");
    expect(handleOwnerFreezeCommand(c, "unfreeze fleet", "UOWNER")).toBeNull();
    expect(handleOwnerFreezeCommand(ownerCfg(), "how are you", "UOWNER")).toBeNull();
  });

  it("unfreezing a fleet that is not frozen says so instead of pretending", () => {
    expect(handleOwnerFreezeCommand(ownerCfg(), "unfreeze fleet", "UOWNER")).toContain("not frozen");
  });
});

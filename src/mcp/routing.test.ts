import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRouting, buildInstructions, recipientError, loadConfig } from "./server.js";

const file = (o: unknown) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-")), "routing.json");
  fs.writeFileSync(p, JSON.stringify(o));
  return p;
};
const ours = {
  default: "chief",
  ownerName: "Owner",
  agents: [
    { id: "chief", desc: "Chief: chief of staff" },
    { id: "infra", desc: "Infra and builds" },
  ],
  marker:
    "[From the owner via claude.ai. Reply with POST /api/messages to owner-mcp, then close this message with the same text as result.]",
};

describe("routing from config", () => {
  it("reads our agents, default, owner name and marker from the file", () => {
    const r = loadRouting(file(ours));
    expect(r.defaultAgent).toBe("chief");
    expect(r.agents.map((a) => a.id)).toEqual(["chief", "infra"]);
    expect(buildInstructions(r)).toContain("infra: Infra and builds");
    expect(buildInstructions(r)).toContain("Owner");
    expect(buildInstructions(r)).not.toContain("nobody");
    expect(r.marker).toContain("owner-mcp");
  });
  it("a broken or empty file refuses to load (fail closed)", () => {
    expect(() => loadRouting(file({ default: "chief", agents: [] }))).toThrow();
    expect(() => loadRouting(file({ default: "nobody", agents: [{ id: "chief", desc: "x" }] }))).toThrow();
    expect(() => loadRouting("/nonexistent/routing.json")).toThrow();
  });
  it("only routed agents may be addressed; owner-mcp never", () => {
    const r = loadRouting(file(ours));
    expect(recipientError(r, "infra")).toBeNull();
    expect(recipientError(r, "nobody")).toMatch(/ismeretlen|unknown/);
    expect(recipientError(r, "pete")).toMatch(/ismeretlen|unknown/);
    expect(recipientError(r, "owner-mcp")).toMatch(/ervenytelen|invalid/);
  });
});

describe("no built-in fleet (public engine): everything personal comes from files", () => {
  it("without a routing file the server refuses to load a routing (no hidden default list)", () => {
    expect(() => loadRouting(undefined)).toThrow(/ROUTING_FILE/);
  });
  it("config defaults carry no site-specific host, address or path: tenant root is required, allowed IP is loopback", () => {
    const rf = file(ours);
    expect(() => loadConfig({ OFFICE_MCP_ROUTING_FILE: rf } as NodeJS.ProcessEnv)).toThrow(/TENANT_ROOT/);
    const c = loadConfig({ OFFICE_TENANT_ROOT: "/t", OFFICE_MCP_ROUTING_FILE: rf } as NodeJS.ProcessEnv);
    expect(c.allowedIps).toEqual(["127.0.0.1"]);
    expect(c.host).toBe("127.0.0.1");
  });
});

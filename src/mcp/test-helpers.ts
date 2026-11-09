// Test-only: loadConfig() needs a routing file (the server has no built-in list of agents), so tests get a neutral one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type McpConfig } from "./server.js";

let fixture: string | undefined;
export function routingFixture(): string {
  if (!fixture) {
    fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-routing-")), "routing.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        default: "chief",
        ownerName: "the owner",
        agents: ["chief", "infra", "qa", "crm", "home", "finance", "coord"].map((id) => ({
          id,
          desc: `${id} handles ${id} things`,
        })),
      }),
    );
  }
  return fixture;
}
export function loadTestConfig(env: NodeJS.ProcessEnv): McpConfig {
  return loadConfig({ OFFICE_MCP_ROUTING_FILE: routingFixture(), ...env });
}

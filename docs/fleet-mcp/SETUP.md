# Fleet MCP: reach your office from claude.ai

A small remote MCP server (Streamable HTTP) that lets you, and the people you choose, ask the agent fleet questions from claude.ai or the Claude apps. It is a standalone service next to the engine: it never touches the engine, it only calls the local dashboard/bus API with the dashboard token.

Credits: the server, its tools and the first setup guide are by Marton (JMarty). The Google sign-in (OAuth 2.1 with the MCP SDK auth router), the config-driven routing, the per-person profiles and the hardening on top were added here.

## What it is, and what it is not

- Sign-in is Google. The server is its own small OAuth 2.1 authorization server (discovery, dynamic client registration, PKCE, consent page, token, refresh with rotation); Google only proves who you are. Only e-mail addresses that have a profile get a token, and each address is pinned to one Google account on its first login.
- Redirect URIs are limited to the claude.ai callbacks (exact match). Tokens: access 1 hour, refresh 7 days with rotation; a reused refresh token revokes the grant. Tokens are stored hashed in one 0600 file. A token whose address is no longer in the profile file is refused.
- Every person has a **profile** (`OFFICE_MCP_PROFILES_FILE`): which tools exist for them, which agents they may message, which memories and kanban cards they may read, a daily message cap with alerts. This is enforced in code, never only by agent instructions. See `profiles.example.json`.
- It is **not** a security boundary for prompt injection: an agent that reads hostile text can be steered. Treat the memory and agent answers a member sees as data that may be wrong, and keep members' profiles narrow.

## Tools

| Tool                                      | Notes                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet_status`                            | Agent state and token use. Members: only agents on their talk list (or none).                                                                                                                                                                                                                                          |
| `search_memories`                         | Read-only. Members: only the agents on their talk list, only rows tagged with one of their allowed tags, minus rows containing a blocked phrase.                                                                                                                                                                       |
| `kanban`                                  | Cards of the agents shown. Members: only their project, minus blocked phrases.                                                                                                                                                                                                                                         |
| `daily_logs`, `read_dream`                | Owner only.                                                                                                                                                                                                                                                                                                            |
| `send_message(to, content, wait_seconds)` | A bus message from the person's own address (`owner-mcp` for the owner, `mcp-<name>` for members), with their header first and a fixed end marker last. Newlines, control characters and square brackets in the text are removed so it cannot fake another message. Waits up to 55 s for the addressed agent's answer. |
| `get_replies(message_id)`                 | Answers addressed to that person's own address only. Members' answers that touch blocked phrases are withheld.                                                                                                                                                                                                         |

Agents answer by `POST /api/messages` to the sender address and close the message with the same text as `result`.

## Files you provide (examples next to this file)

- `routing.example.json` -> `OFFICE_MCP_ROUTING_FILE`: the agents, their one-line roles, the default agent, the bus marker. The server has no built-in list of agents.
- `profiles.example.json` -> `OFFICE_MCP_PROFILES_FILE`: one entry per Google e-mail. Without this file every address in `OFFICE_MCP_ALLOWED_EMAILS` is an owner.
- `fleet-mcp.env.example` -> the unit's environment file (0600, outside the repo).
- `fleet-mcp.service.example` -> a user unit; it listens on 127.0.0.1 only.

Never commit real addresses, hostnames, client ids or secrets to the repo; the examples use `example.com` on purpose.

## Setup

1. `npm ci && npx tsc && npx vitest run src/mcp` in the engine checkout.
2. Google Cloud: create (or reuse) an OAuth client of type "Web application". Add the redirect URI `https://<your-host>/oauth/google/callback`. If the consent screen is in Testing mode, add every profile's Google address as a test user. Put the client secret in a 0600 file named by `OFFICE_MCP_GOOGLE_CLIENT_SECRET_FILE`.
3. Fill the three files above, install the unit, start it. It must answer `401` on `POST /mcp` without a token and `404` on anything else.
4. Expose it. Preferred: a Cloudflare Tunnel (outbound only) from your hostname to `http://127.0.0.1:<port>`; the tunnel must live in the same Cloudflare account as the zone. A reverse proxy works too, but then set `OFFICE_MCP_TRUST_PROXY` and `OFFICE_MCP_ALLOW` for it. Do not put an interactive access gate (for example Cloudflare Access) in front of `/mcp`, `/token`, `/register`, `/authorize` and `/.well-known/*`: claude.ai's own servers call them and cannot sign in to it. The server's Google sign-in is the gate.
5. In claude.ai add a custom connector with the URL `https://<your-host>/mcp` and sign in with a profile's Google account.

## Limits and settings

`OFFICE_MCP_SEND_PER_MIN` (default 5, integer >= 1) is a burst guard for everyone; `OFFICE_MCP_SEND_PER_DAY` (default 30, 0 = no daily cap) applies to owners; members have their own `capPerDay`. At the profile's `alertAt` counts a message goes to the default agent so it can tell the owner. Counters are files, so a restart does not reset them. A typo in these values stops the service at start.

## Operations

- Kill switch: create the file named by `OFFICE_MCP_DISABLED_FILE` (default `<tenant>/store/mcp.disabled`); every request answers 503. Remove it to resume. Reading the flag fails closed. Too many denied owner-login events in ten minutes create it by themselves.
- Revoke everything: stop the service, delete the state file (`OFFICE_MCP_STATE_FILE`), start. Everyone signs in again.
- Remove a person: delete their profile and restart; their token stops working at the next call.
- Audit log: `OFFICE_MCP_LOG` (JSON lines: who, tool, arguments clipped, never a token).
- Roll back: stop the service and remove the hostname's DNS record or tunnel route.

## Not covered

Per-person search budgets, reloading the profile file without a restart, protection against an agent being talked into leaking what a profile may legitimately read.

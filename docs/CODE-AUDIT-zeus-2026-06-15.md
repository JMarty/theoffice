# Code Audit — The Office engine (Zeus / Claude-Opus pass)

Date: 2026-06-15. Scope: `src/**/*.ts` (~3400 LOC), `web-ui/*`, `scripts/*`.
Method: 4 parallel deep reads (web, session/runtime, core/data, features), synthesized.
Independent companion audit by Argus (Gemini) runs separately for cross-check.

## Overall verdict
Consistent and clean. Parameterized SQL throughout (no injection on the main paths),
uniform `json()/log()` error handling, secrets never logged, a clean `Runtime`
interface, `timingSafeEqual` token check, a 0600-precreated DB file. The real
weaknesses are at trust boundaries (proxy headers, dashboard escaping, the update
endpoint), async-runtime robustness (stuck `inFlight`, gemini success detection),
and operational edge cases (no DB migrations, no `delivering`-row reaper).

---

## CRITICAL / HIGH

1. **getClientIp trusts X-Real-IP / X-Forwarded-For unconditionally** — `src/web/server.ts:71-86`
   Reachable without the proxy (LAN bind, `OFFICE_EXTRA_PORTS`) → attacker spoofs the
   header to bypass the rate limit or to lock out a victim's IP. Only honor these
   headers when the socket peer is a trusted proxy (loopback/allowlist); else use
   `req.socket.remoteAddress`.

2. **esc() does not escape `'` + unvalidated agentId/assignee → DOM XSS** — `web-ui/app.js:7`, many inline `onclick`
   Agent ids are server-constrained, but kanban `id`/`assignee`/`project` and memory
   `agentId` come from unvalidated `POST /api/{kanban,memories,daily-log}`
   (`server.ts:303-348`). An apostrophe breaks out of the single-quoted `onclick`.
   Fix: add `'`(&#39;) + backtick to `esc`, or use addEventListener+dataset; validate
   agent identifiers against `loadAgents` on write.

3. **codex/gemini `inFlight` can leak permanently** — `codex-runtime.ts:81-107`, `gemini-runtime.ts:93-121`
   `inFlight.add` runs before `spawn`; a synchronous spawn throw (ENOMEM/bad opts)
   leaves the agent `busy` forever. Codex also has **no turn timeout** (gemini has
   `--print-timeout 10m`), so a wedged `codex exec` strands the agent. Fix: try/catch
   around spawn+wiring that calls `fail()`, and add a codex kill-watchdog.

4. **Gemini success keyed only on exit code 0** — `gemini-runtime.ts:147-156`
   Unlike codex (needs `code===0` AND `sawCompleted`), gemini treats any exit 0 as
   delivered; a usage-limit/error that still exits 0 is swallowed and marked delivered
   (no backoff). Fix: on exit 0, check `sawUsageLimit` (route to cooldown/requeue) and
   ideally assert non-empty output.

5. **Orphaned `delivering` queue rows have no reaper** — `src/queue/index.ts` + `session-manager.ts:56`
   `markDelivering` flips status before the async turn; a crash mid-turn strands the row
   (`listQueued` only selects `queued`) — never retried, never failed. Fix: on boot
   `UPDATE inbound_queue SET status='queued' WHERE status='delivering'` (bounded by attempts).

6. **/api/update/apply is host-credential-equivalent** — `web-ui ... server.ts:284-291`, `update.ts`
   The bearer token can trigger `git pull` + `npm install` + `npm run build` + restart,
   i.e. remote code execution by design, and it returns raw git/npm output to the client.
   Treat the token as a host credential; consider loopback-only or a second confirm
   secret; return a sanitized summary, log full output server-side.

## MEDIUM

7. **No DB migration mechanism** — `src/db/index.ts`, `schema.ts` — `CREATE TABLE IF NOT EXISTS` only;
   an existing table cannot gain a column on upgrade. Add a `PRAGMA user_version`-gated runner.

8. **NaN guards missing on numeric env overrides** — `config.ts:104,113-116` — `Number("foo")`→NaN flows
   into bind/rate-limiter silently. Parse with `Number.isFinite` guard + warn.

9. **Outbound has no idempotency** — `queue/index.ts:114-118`, `slack-send.ts:46-53` — a Slack-delivered
   send whose API call then throws is retried → double post. Add a dedup key or only retry pre-send errors.

10. **Slack file download** — `channel/files.ts:38,42` — bot token attached to the Slack-provided URL with
    no host allowlist, and the whole file is buffered with no size cap. Assert `.slack.com` host + bound size.

11. **readBody resolves empty on error/oversize** — `server.ts:49-59` — can hang on `req.destroy()` or
    silently truncate; can't return 413. Reject distinctly and always settle.

12. **Static serving** — `server.ts:518-531` — serves any file under `web-ui/` (outside the auth gate) with a
    permissive MIME fallback; keep nothing sensitive there, prefer an extension allowlist.

13. **DM-only not enforced** — `slack-ingest.ts:58-70` — parser accepts channel posts (manifest is `message.im`
    only, so safe today). If DM-only is the intent, reject `channel_type !== "im"`.

## LOW / cleanliness / consistency

- Successful auth deletes the rate-limit entry, resetting the escalation `blocks` counter — `server.ts:132-134`.
- Mixed clocks: rate-limiter uses injectable `_now()`, usage uses `Date.now()` — `server.ts:254`, `usage.ts:55`.
- `daily-log` date hardcodes `Europe/Budapest` — `server.ts:306` (CLAUDE.md says read TZ from config).
- session name `agent-${id}` duplicated in codex/gemini instead of `sessionNameFor()` — `codex-runtime.ts:67`, `gemini-runtime.ts:71`.
- Dead config fields `appTokenRef`/`botTokenRef` — `types.ts:107-110` (read nowhere).
- Dead `if (!cfg.web.rateLimit)` fallback (platform default always sets it) — `config.ts:109-112`.
- `recordInbound`/`recordOutbound` near-identical — `memory/conversation.ts:5-21` (extract one helper).
- `parseJson` typed `{[k]:any}` — defeats body type-checking — `server.ts:507-516`.
- Stale comments: `runtime.ts:11-14,34` ("two runtimes" — three exist); MAX_CODEX "enforces automatically" but
  server only soft-warns (`app.js:472` vs `server.ts:456-459`); slack-ingest "DMs or channel posts".
- `readEnvFile` doesn't strip `export ` / inline `#` comments — `env.ts:11-26` (feeds child-process env).
- FTS empty-term sentinel `'""'` can error on some builds — `memory/store.ts:78`.
- `recallForPrompt` filters category in JS after fetching 18 rows → may miss deep cold/shared — `recall.ts:33-35`.
- Migration importer interpolates table/column identifiers (hardcoded whitelist today) — `import-claudeclaw.ts:117-124`.

## Suggested fix order (Zeus)
1. getClientIp proxy-trust (#1) + dashboard esc/validation (#2) — close the two real security gaps.
2. Runtime robustness: inFlight cleanup + codex timeout (#3) + gemini success detection (#4).
3. delivering-row reaper (#5) — prevents silently stranded messages.
4. DB migration runner (#7) + NaN env guards (#8).
5. Cleanliness sweep: dead fields/fallback, dup helpers, stale comments.

---

## Argus (Gemini) independent cross-check — 2026-06-15

Run separately on the Gemini/Antigravity runtime for a second-model perspective.

### Agreements with the Zeus pass (highest-confidence findings)
- Orphaned `delivering` rows / no boot reaper — Argus HIGH (queue/index.ts) == Zeus #5.
- Dashboard `esc()`/innerHTML XSS surface — Argus NIT, Zeus #2 HIGH (agree it exists; differ on severity).
- `usage.ts` sync fs blocks the event loop — both (Argus MEDIUM).
- usage-limit regex tested on chunk boundaries — Argus HIGH, Zeus LOW.
- `readBody` resolves empty on error/oversize — both.
- `rlMap` O(N) cleanup — both LOW.
- Hot-tick sync IO (`loadAgents` every 2s, `loadScheduledTasks` every 30s, `displayNameFor`) — both (cache it).

### Argus-only (Zeus missed)
- **HIGH: `.env` blindly overrides `PATH`/`TZ`/`HOME`** — `claude/codex/gemini-runtime` env build; an agent `.env` can clobber the PATH that lets `office-say`/binaries resolve. Append/prepend PATH; don't let `.env` overwrite PATH/HOME/TZ.
- NIT: `.env` parser has no escape-sequence support (multiline PEM secrets).
- NIT: `deepMerge` structuredClone perf (fine for config sizes).

### Zeus-only (Argus rated clean / missed)
- getClientIp header spoofing (rate-limit bypass) — HIGH security.
- inFlight leak on sync spawn throw + no codex turn timeout — HIGH robustness.
- gemini success-on-exit-0 swallows usage-limit/empty turns — HIGH.
- /api/update/apply is host-credential-equivalent — HIGH.
- No DB migration mechanism; NaN env guards; outbound double-post; Slack file host/size; unvalidated agentId on write — MEDIUM.
- Argus rated the DB layer "bulletproof"; Zeus flagged the missing migration path as MEDIUM (divergence).

## Unified fix priority
1. **delivering-reaper + runtime robustness (inFlight cleanup, codex timeout) + gemini turn-completion check** — also fixes the Antigravity "received but didn't act" reliability problem.
2. Security: getClientIp proxy-trust + dashboard esc/validation.
3. `.env` PATH protection (Argus) + usage-regex buffering.
4. Perf: async/cache the hot-tick sync IO.
5. Cleanliness: DB migration, NaN guards, dead fields, stale comments.
- LOW (Argus re-run): `projectDirFor` maps both `/` and `.` to `-` (usage.ts:16) — `/home/user/app` and `/home/user.app` collide, merging two agents usage. Use a hash of the path.

### CRITICAL (Argus deep-pass, confirmed by Zeus) — security-profile bypass via runtime
- **Restricted security profiles are NOT enforced on codex/gemini runtimes.** `profile.ts` writes
  `tenant/agents/<id>/.claude/settings.json` deny rules (incl. `Read(secrets/**)`, the DB files, and the
  vault key) for non-`full` profiles — but **only Claude Code reads `.claude/settings.json`**. Codex spawns
  with `--dangerously-bypass-approvals-and-sandbox` (`codex-runtime.ts:98`) and gemini with
  `--dangerously-skip-permissions` (`gemini-runtime.ts:111`); neither honors the deny list. So a restricted
  agent (e.g. a "shared" agent meant to be walled off from secrets/finances) gains FULL host access the
  moment its runtime is switched to codex/gemini (switchable from the dashboard). This silently breaks the
  documented per-agent security-profile feature.
  Fix: refuse to run a non-`full` profile on a runtime that can't enforce it (reject the runtime switch and
  the delivery with a clear error), or implement equivalent enforcement for codex/gemini. **This is now the
  #1 security fix.**
- NIT (Argus): `deepMerge` does not skip `__proto__` (config.ts) — structuredClone would DataCloneError (boot DoS, not prototype pollution); config is owner-controlled. Optional: ignore `__proto__` on merge.

---

## CLARIFICATION / SEVERITY CORRECTION (2026-06-15, after web research)

The "security-profile bypass" item above was over-rated as CRITICAL for *our* deployment.
Authoritative findings (Anthropic / OpenAI / Google docs):

- **`--dangerously-skip-permissions` (and codex `--dangerously-bypass-approvals-and-sandbox`)
  is REQUIRED for unattended/headless agents** and must stay. Without it the agents can't run
  office-say / memory writes / git without a human approving each call. "The box is the boundary"
  is the correct posture for a single-user self-hosted host.
- **On Claude Code, `permissions.deny` rules STILL apply under `--dangerously-skip-permissions`**
  (deny + ask rules apply in every mode incl. bypassPermissions). So the restricted-profile
  deny-list (secrets/DB/vault) IS genuinely enforced on the claude runtime even with the flag.
- **On codex/gemini there is no equivalent deny layer** (`.claude/settings.json` is Claude-only),
  and the dangerous flag also disables their sandbox — so a restricted profile is not enforced there.

**Severity for THIS deployment: LOW / informational, not CRITICAL.** All current agents are `full`
profile, all are the owner's own trusted agents on the owner's own box → zero current exposure.
It only matters if a restricted/shared (third-party-reachable) agent is ever added.

**Correct action (not urgent):** treat as a documented limitation — "restricted profiles are only
enforced on the Claude runtime" — and optionally add a guardrail: the engine should warn/refuse when
a non-`full` profile is set on a codex/gemini agent (or keep restricted/shared agents on Claude).
Do NOT "fix" by removing the dangerous flags.

Sources: Claude Code Permission modes & Permissions docs (deny applies in bypassPermissions);
OpenAI Codex CLI reference (--dangerously-bypass-approvals-and-sandbox removes approvals+sandbox);
Google Antigravity CLI permissions + antigravity-cli issue #36 (skip-permissions also bypasses sandbox).

# Handoff: The Office — Mission Control (dashboard redesign)

## Overview
This is the production-ready redesign of **The Office mission-control dashboard** — the web supervision UI for the self-hosted multi-agent engine (`theoffice.service`, served at `ai.ladikos.hu` / LAN `:3430`). It replaces the current prototype dashboard.

The dashboard is the **occasional supervision surface** for a single power user: it shows what each agent is, its live status, memory/kanban/queue/schedules, message bus, token usage, logs, and engine/host health. Day-to-day interaction stays in Slack; this is "open it when you want to look."

**Chosen direction:** "Refined Ops" — dark-first ops dashboard with a top header, a stat strip, and a horizontal tab bar. Light mode, density modes, and accent color are built in.

---

## About the design files
The file in this bundle (`Mission Control.dc.html`) is a **design reference created in HTML** — a working prototype that shows the intended look and behavior. **It is not production code to copy directly.** Your task is to **recreate this design in the dashboard's existing environment** (the same stack the current dashboard already uses — vanilla JS, React, or whatever the engine serves), following that codebase's established patterns. If there is no front-end framework in place yet, plain HTML/CSS/JS is perfectly appropriate here — keep it dependency-light, it's a single-user internal tool.

The prototype uses a small in-house template runtime (`support.js`) only so it can render standalone. **Do not port `support.js`.** Read the HTML for exact styles/structure and the `<script>` logic class for data shape, state, and formatting logic; reimplement both natively.

### How to view it
Open `Mission Control.dc.html` in a browser (keep `support.js` next to it). Use the top-right controls to flip **Dark/Light**, **Cozy/Compact**, and the **accent swatches** to see every combination. Click tabs to see all views. The Restart/Stop/Disable buttons mutate agent state live.

---

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interactions are final. Recreate pixel-faithfully. All exact values are in `design-tokens.json` and repeated inline below.

---

## Global layout & theming

### Page frame
- Centered column, `max-width: 1480px`, page padding `24px 28px 64px`.
- `min-height: 100vh`, background `var(--bg)`, text `var(--text)`, base font 14px / line-height 1.45, `-webkit-font-smoothing: antialiased`.
- `* { box-sizing: border-box }`, `body { margin: 0 }`.

### Theming model (important)
Theme is **not** class- or media-query-based. A single root element sets CSS custom properties; **every other element reads `var(--token)`**. Switching theme/accent/density swaps the values on that one root. Recommended tokens (see `design-tokens.json` for all values):

`--bg --bg2 --surface --surface2 --border --border2 --text --dim --faint --accent --accentSoft --accentLine --ok --warn --danger --info --pad --gap`

- `--accentSoft` = accent at alpha **0.16 (dark) / 0.12 (light)** — used for active-nav and primary-soft backgrounds.
- `--accentLine` = accent at alpha **0.45 (dark) / 0.35 (light)** — pulsing-dot ring color.
- **Density** changes only `--pad`, `--gap`, and the agent-card grid min (`312px` cozy / `272px` compact).
- Persist the user's theme/density/accent choice in `localStorage`.

### Type rules
- **`IBM Plex Mono`** for: all uppercase micro-labels (`AGENTS ONLINE`, `RUNTIME`, `MODEL`, …) with `letter-spacing .1–.18em text-transform: uppercase`; numeric metrics; `@handles`; timestamps; log lines; version strings; host stats.
- **`IBM Plex Sans`** for everything else.
- Big metric numbers: `font-weight 700`, `letter-spacing -.02em`, `font-variant-numeric: tabular-nums` on anything that ticks.

---

## Header (sticky, top)
- `position: sticky; top: 0; z-index: 40`, background `var(--bg2)`, `border-bottom: 1px solid var(--border)`, `backdrop-filter: blur(8px)`. Inner row padding `13px 28px`, same 1480 max-width, `space-between`.
- **Left — brand:** 34×34 rounded-9px square filled `var(--accent)`, dark glyph "O" (weight 700, 17px) + stacked wordmark: **"The Office"** (700, 16px) over **"MISSION CONTROL"** (mono, 10px, `letter-spacing .18em`, uppercase, `var(--faint)`).
- **Right — controls cluster** (flex, gap 10, wraps):
  1. **Connection pill** — `var(--surface)` bg, `1px var(--border)`, radius 9, padding `7px 13px`: a 7px `var(--ok)` dot that **pulses** (animation `pulseDot 2.4s`), bold "connected", a 1px divider, mono `ai.ladikos.hu`, then a **live clock** `HH:MM:SS` in `var(--faint)` updating every second.
  2. **Theme segmented control** — `[Dark | Light]`. Container `var(--surface)`/border, radius 10, 4px pad. Active segment: `var(--accentSoft)` bg + `var(--accent)` text, weight 600. Inactive: transparent + `var(--dim)`, weight 500.
  3. **Density segmented control** — `[Cozy | Compact]`, same styling.
  4. **Accent swatches** — 4 round 17px buttons (green `#3ddc91`, blue `#6ea8ff`, amber `#f5b14c`, violet `#b69bff`); the active one has a `2px solid var(--text)` ring.

---

## Stat strip
- `display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--gap)`, margin-bottom 22px.
- Each card: `var(--surface)`, `1px var(--border)`, radius 14, padding `var(--pad)`. Big number (28px/700/`-.02em`) + mono uppercase label (10px, `letter-spacing .13em`, `var(--dim)`, margin-top 6).
- The six cards, in order:
  1. **Agents online** — `4 / 4` (the "/ 4" is `var(--faint)`, 16px). Below: a row of four 9px dots in the four agent colors.
  2. **Memories** — `72`. Below: a 6px segmented bar (radius 4, bg `var(--bg2)`) split **hot 33.3% `var(--danger)` · warm 65.3% `var(--warn)` · cold 1.4% `var(--info)`**, then mono caption `24 hot · 47 warm · 1 cold` (`var(--faint)`).
  3. **Tokens today** — live total (e.g. `202.4k`, tabular-nums). Below: a 6px `var(--accent)` dot pulsing + `live · across 4 agents` (`var(--faint)`).
  4. **Kanban open** — `5`, caption `2 in progress · 1 review`.
  5. **Queue** — `0`, caption `clear` in `var(--ok)`.
  6. **Schedules** — `3 / 3`, caption `next · briefing 07:30`.

> Note: the prototype shows populated kanban/usage to demonstrate the design. Wire these numbers to live engine data.

---

## Tab navigation
- Horizontal row, `border-bottom: 1px solid var(--border)`, `gap: 4px`, horizontally scrollable, margin-bottom 22px.
- Tabs (in order): **Agents · Memory · Kanban · Schedules · Queue · Messages · Usage · Logs · Update**.
- Each tab button: `padding 10px 15px`, no side/top border, `border-bottom: 2px solid` (`var(--accent)` if active else transparent, sits over the nav's bottom border via `margin-bottom: -1px`), background transparent. Active: text `var(--text)`, weight 600. Inactive: `var(--dim)`, weight 500.
- A tab may carry a **count badge** (shown when count > 0): mono 10.5px, `padding 1px 7px`, radius 10. Active badge: `var(--accentSoft)` bg + `var(--accent)`. Inactive: `rgba(faint,.16)` bg + `var(--dim)`. Counts in prototype: Memory 72, Kanban 5, Schedules 3.

---

## View: Agents (default)
Grid: `repeat(auto-fill, minmax(<agentCardMin>, 1fr))`, `gap: var(--gap)`.

**Agent card** — `var(--surface)`, `1px var(--border)`, radius 16, padding `var(--pad)`. Disabled agents render at `opacity: .55` (transition .2s). Top-to-bottom:

1. **Header row** (flex, gap 12, align flex-start):
   - **Monogram coin** 42×42, radius 11, bg = agent color, dark text `#0b0c0e`, weight 700, 18px, first letter of name.
   - **Name block:** name (700, 16px, `-.01em`) + mono `@handle` (11px, `var(--faint)`) on one line; role (12.5px, `var(--dim)`) below.
   - **Status badge** (pushed right): pill `padding 4px 10px`, radius 20, bg = `rgba(statusColor, .14)`, text = statusColor, weight 600, 11.5px, capitalized. Leading 7px dot in statusColor; **pulses** for `running`/`restarting` (see status map in tokens).
2. **Activity strip** (margin-top 14): inner panel `var(--bg2)`, `1px var(--border)`, radius 10, `padding 10px 12px`, min-height 42, flex row. Leading dot + one-line ellipsized activity text colored by state. If running, a mono elapsed timer `MM:SS` in `var(--info)` on the right, ticking every second. Copy by state: running → the task text; restarting → `Restarting runtime…`; unknown → `Status unknown — cold start`; offline → `Stopped`; disabled → `Disabled`; idle → `Idle — awaiting tasks`.
3. **Runtime / Model selects** (margin-top 14, grid gap 11): each is a row — mono uppercase label (`runtime` / `model`, 11px, fixed 58px width, `var(--faint)`) + a **full-width native `<select>`** (`flex: 1; min-width: 0`) styled `var(--bg2)` bg, `1px var(--border2)`, radius 8, `padding 7px 10px`, 12.5px. **(Fixes the original bug where dropdown text was clipped — the control must be full width with room for the native chevron.)**
   - Runtime options: `Claude Code`, `Codex`, `Antigravity`.
   - Model options: `Opus 4.8`, `Sonnet 4.8`, `Haiku 4`, `default`, `Gemini 3.1 Pro`, `Gemini 3.1 Flash`, `GPT-5 Codex`.
4. **Stat tiles** (margin-top 14, flex gap 8): three `var(--bg2)` tiles radius 9, `padding 9px 11px` — **memories** (flex 1), **tokens** (flex 1.3), **active** (flex 1). Each: mono micro-label (9.5px, `letter-spacing .1em`, uppercase, `var(--faint)`) + value (16px, 700, tabular-nums). Tokens for a running agent tick live.
5. **Action row** (margin-top 14, flex gap 8):
   - **Restart** — primary, `flex: 1`, `var(--accent)` bg, dark text `#0b0c0e`, no border, radius 9, `padding 9px`, weight 600.
   - **Stop** — ghost, transparent, `var(--dim)` text, `1px var(--border2)`, radius 9, `padding 9px 14px`.
   - **Disable** — ghost-danger, transparent, **`var(--danger)` text**, `1px var(--border2)`, radius 9. (Destructive action is visually distinct — the original made all three identical.)

### Seeded agents (prototype data — replace with live)
| Name | Role | Handle | Runtime | Model | Status | Memories | Color |
|---|---|---|---|---|---|---|---|
| Zeus | CEO | @zeus | Claude Code | Opus 4.8 | idle | 49 | `#b69bff` |
| Hermes | VIP Rent | @hermes | Claude Code | default | running (task: "Drafting weekly tenant report") | 7 | `#6ea8ff` |
| Hestia | Home & IT | @home | Claude Code | Opus 4.8 | idle | 12 | `#3ddc91` |
| Argus | Infra & QA | @argus | Antigravity | Gemini 3.1 Pro | unknown | 4 | `#f5b14c` |

> Agent names, roles, handles, runtimes and identity colors are all **configurable per agent** — do not hard-code them.

---

## View: Memory
- Filter row: chips `All 72 / Hot 24 / Warm 47 / Cold 1` (active chip = `var(--accentSoft)`/`var(--accent)`; others = surface + border + dim) and a right-aligned search input (surface, border, radius 9, `padding 9px 13px`, max-width 320).
- List: one `var(--surface)` card, rows separated by `1px var(--border)`. Each row (flex, gap 14, `padding 14px 18px`): **tier tag** (mono 10px uppercase pill, bg `rgba(tierColor,.15)` text tierColor — hot=`danger`, warm=`warn`, cold=`info`), the memory text (13.5px, ellipsized, flex 1), an author chip (18px rounded-5 square in agent color + dark initial) with agent name (12px dim, fixed 54px), and a right mono `ago` timestamp (11.5px faint).

## View: Kanban
- 4 equal columns (`grid-template-columns: repeat(4, 1fr)`, gap 14): **Backlog · In progress · Review · Done**.
- Column: `var(--bg2)`, `1px var(--border)`, radius 14, padding 13, min-height 240. Header: uppercase column name (12.5px, `letter-spacing .06em`, `var(--dim)`) + mono count.
- Card: `var(--surface)`, `1px var(--border)`, radius 10, padding 12, **`border-left: 3px solid <agent color>`**. Title (13px/500) + author chip (16px coin + name, 11.5px faint).

## View: Schedules
- Stacked rows, gap 12. Row: `var(--surface)`, border, radius 14, padding `var(--pad)`, flex align-center gap 18: owner coin (38px, radius 10), name (600/15) + `owner · cadence` (12.5px dim), right block `next run` (mono uppercase micro-label + mono value), an **"on" pill** (`rgba(ok,.12)` bg, `var(--ok)` text, dot), and a ghost **Run now** button.
- Seeded: Morning briefing (Zeus, daily 07:30, next 9h 12m); Infra audit & QA sweep (Argus, daily 02:00, next 3h 40m); Token usage report (Argus, Mon 09:00, next 2d 18h).

## View: Queue (empty state)
- Centered card, `padding 72px 24px`: a 56px circle outlined `2px var(--border2)` containing a 14px `var(--ok)` dot, then **"Queue is clear"** (18px/700) and a muted one-liner. This is the canonical empty-state pattern — reuse it for any other empty list.

## View: Messages
- The internal **agent message bus** feed. One `var(--surface)` card, rows divided by border. Row (flex gap 13, `padding 15px 18px`): author coin (28px) + body: header line `<from> → <to>` (from bold, arrow faint, to dim) with right-aligned mono `ago`, then the message text (13.5px).
- Seeded examples include `Hermes → Zeus`, `Argus → all`, etc.

## View: Usage
- 2-column grid (`1.4fr 1fr`, gap 14), four panels (surface/border/radius 14/`padding var(--pad)`):
  1. **Tokens · last 7 days** — bar chart, 150px tall, 7 bars (`Mon…Sun`), `radius 6px 6px 0 0`. Past days = `rgba(accent,.35)`; today (last bar) = solid `var(--accent)`. Mono day labels. Heights are % of max (prototype values `[120,86,140,98,160,210,178]`).
  2. **By agent · today** — per-agent horizontal bars: label (9px agent-color square + name) + mono token count; track `var(--bg2)` 7px radius 4, fill = agent color, width = tokens/max. Running agent's bar grows live.
  3. **By runtime** — three bars: Claude Code 78% (`#6ea8ff`), Antigravity 14% (`#f5b14c`), Codex 8% (`#b69bff`).
  4. **Codex concurrency** — big `0 / 2 slots` + note: "Capped at 2 agents due to OpenAI's 5-hour limit. Engine enforces this automatically." (Surface this whenever Codex is selected as a runtime.)

## View: Logs
- Terminal panel, near-black bg `#08090a`, border, radius 14, padding `16px 18px`, **all mono 12.5px**, line-height 1.9, horizontal scroll. Each line: `time` (faint) · `LEVEL` (48px col, colored + bold: INFO=`var(--dim)`, WARN=`var(--warn)`, ERROR=`var(--danger)`, DEBUG=`var(--faint)`) · `src` (64px col, dim) · `msg`. A blinking block cursor (`var(--accent)`, `blink 1.1s steps(1) infinite`) sits at the bottom — this is the live tail; append new lines as they stream.

## View: Update
- 2-column grid (`1.3fr 1fr`, gap 14):
  - **Left:** service name (`theoffice.service`, mono micro-label) + version `v0.9.4` (22px/700) + an **"up to date" pill** (ok-tinted). "Last checked … · auto-checks daily". Divider. **Recent changes** list (mono version tag — current version in `var(--accent)`, older in `var(--faint)` — + dim description). Buttons: **Check for updates** (primary accent) + **Restart engine** (ghost).
  - **Right — Host:** key/value rows — Uptime (mono), CPU (`18% · 2 vCPU` + an 18% `var(--ok)` meter), Memory (`4.1 / 8 GB` + a 51% `var(--warn)` meter), Runtime (`Node · container`), Endpoint (`:3430`). Meter track `var(--bg2)`, 6px, radius 4.

---

## Interactions & behavior
- **Tab switching:** instant; preserve per-tab scroll if cheap, otherwise reset to top.
- **Restart (per agent):** status → `restarting` (dot pulses, activity "Restarting runtime…") then after ~1.7s → `idle` with `last = now`. Wire to the real restart endpoint; keep the optimistic in-between state.
- **Stop:** status → `offline`, clears task. **Disable:** status → `disabled`, card dims to .55. Both should confirm against the engine.
- **Live tick (1s):** updates the header clock, each running agent's elapsed `MM:SS`, and the running agent's token counter (+ the global "Tokens today" total + the agent's usage bar). Replace the prototype's random increment with real engine telemetry (poll or WebSocket).
- **Status dots** pulse only for `running` and `restarting` (`pulseDot 1.6s ease-out infinite`, `--dc` = dot color at .55 alpha).
- **Theme / density / accent:** apply by swapping the root CSS variables; persist in `localStorage`.
- **Selects:** changing runtime/model should POST the change to the engine; reflect Codex's 2-slot constraint in the UI (disable/annotate Codex when 2 agents already use it).
- **No drop shadows** in this design — separation is surface + 1px border only.

## State / data the dashboard needs
- **Agents[]**: `{ id, name, role, handle, runtime, model, status, memories, color, task, startedAt, tokensToday, lastActive }`. `status ∈ {running, idle, unknown, offline, restarting, disabled}`.
- **Globals**: agents online, total memories + tier counts (hot/warm/cold), tokens-today total, kanban open count, queue length, schedules active/total, connection state, host stats (uptime/cpu/mem), engine version + update availability.
- **Lists**: memories, kanban (4 columns of cards), schedules, message-bus messages, log lines, 7-day usage series, per-runtime split.
- **UI prefs (localStorage)**: theme, density, accent.

## Responsive
- Built for desktop (≥1100px). The agent grid and stat strip already reflow via `auto-fill` / `auto-fit`. Header controls wrap. Kanban's fixed 4-column grid and the 2-column Usage/Update grids should collapse to 1–2 columns below ~900px if mobile matters (low priority — this is opened on a desktop browser).

## Assets
- **Fonts:** IBM Plex Sans + IBM Plex Mono (Google Fonts import string in `design-tokens.json`). Self-host if the engine should work offline on LAN.
- **No image assets.** All visuals are CSS (coins, dots, bars, meters). No icon font / SVG icon set is required; if you add icons later, keep them minimal and monochrome to match.

## Files in this bundle
- `Mission Control.dc.html` — the working hi-fi reference (open in a browser; needs `support.js` beside it). Read its inline styles for exact CSS and its `<script>` class for data shape, formatting (`fmtTokens`, `fmtClock`, `elapsed`), the status→color map, and the palette/spacing functions.
- `support.js` — prototype runtime only, so the reference renders. **Do not port it.**
- `design-tokens.json` — every color/spacing/type/motion token, machine-readable.
- `README.md` — this document.

> There is also a second explored direction (a left-sidebar "Roster" layout) in the parent project as `Mission Control Roster.dc.html`. The chosen production direction is the one documented here.

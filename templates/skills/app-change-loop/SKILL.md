---
name: app-change-loop
description: The spec -> build -> paired screenshots -> marveen check -> Toby -> deploy -> live check -> CHANGELOG -> tell owner loop for ANY owner-driven change to a live web app (Split, an event, Strategy Day, partner-poli, the company site/CRM, meetup pages). Use when Owner asks to change text, layout, data or a feature in an app that real people use, incl. "make it look like the rest of the app", "change this copy", "add X to the app". Not for the company client demos (kops-client-demo-build) or UX click-through QA (app-ux-clickthrough-qa).
---
# App change loop (owner ask -> live, verified, logged)

Distilled from ~10 Split rounds (2026-10-02/03), the Strategy Day rounds (10-27, 10-30), the the company home/About copy
iteration (10-22/23) and the spec-build-qa-deploy cycles of 10-06. Roles: marveen writes the spec and every
user-facing string, Darryl builds + deploys, Toby QAs, marveen checks before the owner sees anything.

## Mikor használd
- Owner asks for any change in a live app: copy, layout, a new block/page, data correction, a small feature.
- Several asks arrive in one session (Strategy Day 10-27 had 12): each one is a numbered section of the SAME spec file.
- Not for: brand-new client demos (kops-client-demo-build), deep UX/edge QA (app-ux-clickthrough-qa).

## Eljárás
1. *Ack the owner first* (one office-say line), then card it (kanban) - memory ack-the-owner-before-the-work.
2. *SPEC file*, never inline bus text. Path next to the app's other specs, e.g.
   `agents/marveen/strategy-day-ams/APP-UPDATE-SPEC-20261027.md`, `split-app-content/<feature>/SPEC.md`,
   `kops/<x>/SPEC-*.md`. Skeleton:
   - header: app, repo/branch ("deploy from master only"), widths to show (390/412 + 1366/1440, 1920 if desktop matters).
   - numbered items, one per owner ask, with the owner's time + words ("OWNER 15:3x: ...").
   - *exact final copy*, written by me and read as the END USER (no organiser notes: "extended", "confirmed by hotel",
     "requested via Perk"; bold only for titles; lists as lists - owner 10-27).
   - a *Must NOT appear* list (old strings, prices, "confirmed" when it is not, names that must stay private).
   - a size label (xs/s/m/l/xl) and a *Done when* list of numbered, verifiable DoD lines (rules: engineering-discipline-gates, 'Adopted from the Marvin kit'): screenshots at the widths (light + dark if the app has dark), the live grep for absence/presence,
     Toby re-check scope, "bus marveen ONE line with deploy id + rollback id", "do not send the link to anyone".
   Example: `agents/marveen/strategy-day-ams/APP-UPDATE-TRANSFERS-20261030.md`.
   Copy-only iteration (the company site): ONE payload file with exact OLD -> NEW strings; inline bus strings got clipped and
   crossed 3 times (memory 6580).
3. *Design reference.* Name the EXISTING screen the new thing must match (Split: Flight board / Schedule day tabs, Rooms
   booking sheet). Require "reuse the component itself, not a look-alike; no native controls (select/date/checkbox
   default look); no orphan cells; no mid-word breaks". Headshots UI was rejected 4x until we did this (10-01).
4. *Hand off*: one bus line to Darryl: "spec at <path>, items N-M". Nothing else on the bus (pair breaker, see
   inter-agent-message-processing).
5. *Builder returns paired screenshots*: NEW screen next to the EXISTING reference screen, same widths (412 + 1440,
   1920 for desktop asks). Strategy Day kept them in `agents/marveen/strategy-day/design-compare/` and `shots-YYYYMMDD/`.
6. *Marveen check - rendered, not DOM.* Open the PNGs (Read tool) and compare against the reference shot: edges,
   outline, font, button shape, spacing, alignment across columns, wrapping. Checking that the shot matches the REQUEST is
   not checking that it matches the APP (memory split-app-new-design-only, recurred 10-06, 10-08 x2, 10-14).
   A passing test suite or DOM count is not a UI check (B1: 172 tests + DOM check green 3x while the screenshot still
   showed the bug; cause display:flex on a td). Bounce mismatches to Darryl before the owner sees anything.
7. *Toby*: scope = the numbered items + the Must-NOT list (QA brief per app, e.g. `darryl/work/strategy-day/QA-BRIEF.md`).
   Relay his verdict verbatim (memory relay-verdicts-verbatim).
8. *Deploy* (Darryl): from master/main only (`git branch --show-current` first; feat-branch deploy regressed the the company
   home 10-23). Record the deploy id AND the rollback id (previous deployment) in the bus line and the CHANGELOG/memory.
   Pages: `wrangler pages deploy public --project-name <p> --branch main`; rollback = Cloudflare API
   `pages/projects/<p>/deployments/<id>/rollback`.
9. *Wait for the deploy to finish* (GitHub auto-deploy or wrangler) before any live check. A version bump is not a deploy.
10. *Live check (mine, on the production URL):*
    - presence: every new string is there; absence: every OLD/forbidden string is gone. Tokenize/grep the rendered text,
      not the source (Toby's `toby/audits/transfers-text-shots/t3.py` pattern: `inner_text('body')` per page, a `BAD`
      regex, light+dark, 390+1366, `scrollWidth>innerWidth` = no horizontal scroll).
    - the served version (`app.js?v=`, sw version, deploy id), anonymous API = 401, og tags if touched.
    - for per-person apps: view as 2-4 different people (Strategy Day: PersonD, PersonE, PersonJ, PersonA).
11. *CHANGELOG (mandatory, before telling the owner)*: newest-first entry in the repo's `CHANGELOG.md` (e.g.
    `darryl/work/strategy-day/CHANGELOG.md`): date, owner ask in one line, what changed in user words, live commit.
    10-30 the CHANGELOG was skipped and only the 21:00 github-sync caught it.
12. *Only now tell the owner*: what changed, the live link (Slack `<url|label>`), 1-2 screenshots via slack-file-upload,
    and anything still pending. Mirror the company changes into the CRM the same turn (memory crm-mirror-every-change).

## Buktatók
- *Crossed bus messages*: before re-asking Darryl "is X done?", read `git log --oneline -10` in his work dir and the
  live version. 10-06 had ~8 crossed/duplicate rounds that git log would have answered.
- *My brief causes the copy bug*: organiser info in the brief ends up on attendee pages (owner 10-27 "why dont you think
  before you do"). Write the final copy myself, verbatim, in the spec.
- *Sweep after a rule*: when the owner corrects one page ("no bold body text"), the spec must say "sweep every page and
  every view for the same fault" - he finds the second instance otherwise.
- *Data vs deploy*: some apps keep data in D1/KV (Strategy Day `people.trip`): a data fix needs no deploy but still needs
  the live check and a CHANGELOG line.
- *Never forward personal links* (Strategy Day `app-links.txt`): distribution waits on the owner.
- *Dark mode*: if the app has none (Strategy Day uses Split's system, no dark theme), say so instead of skipping silently.

## Ellenőrzés
- Spec file exists with numbered items, exact copy, Must-NOT list, Done-when.
- I looked at paired PNGs against an existing screen myself, at both widths.
- Toby verdict (verbatim) is on record; deploy id + rollback id recorded.
- Live grep: all new strings present, all old/forbidden strings absent, on production, after the deploy finished.
- CHANGELOG entry committed BEFORE the owner message.

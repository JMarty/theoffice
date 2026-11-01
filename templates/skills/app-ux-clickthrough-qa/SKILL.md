---
name: app-ux-clickthrough-qa
description: Real-user UX QA of a web app before the owner or a partner/client sees it - parameterised Playwright click-through (phone 390 + laptop 1366, every role e.g. owner + partner, a screenshot per step), privacy crawl (partner must never see owner-only data), edge tests (typing while a poll refreshes, two devices on one record, parallel save), and the owner-walk tracker with an A-R findings list. Use for the office CRM/portal/client apps (a client app, a client app, the client app), Split/Strategy Day style apps, "walk it as a user", "check it on phone and laptop", "can Laci see my private deals?", "track what the owner clicks while he tests".
---
# App UX click-through QA

Built from: Toby's the office Dashboard privacy attack (`agents/toby/evidence/2026-10-21-kops-dashboard-privacy/`: REPORT.md,
lib.py, ui.py), the Demó-terv merge reviews (`agents/marveen/kops/demo-spec-tool/MERGE-STEP*-REVIEW-marveen.md`,
`qa-scripts/step4*`), the owner e2e test 10-24 (`E2E-OWNER-TEST-2026-10-24*.md`, `darryl/tools/owner-trace/dump.sh`),
and the portal walks (`darryl/work/kops-poll/tests/portal_ui_walk.py`, `toby/audits/portal-fixes-b35ad53-shots/`).

## Mikor használd
- A build claims "done" on a UI the owner, Laci or a client will touch. Feature-by-feature checks are not enough:
  10-29 every feature passed while the end-to-end client send was broken (kops-client-demo-build Buktatók).
- A role split exists (owner vs partner, organiser vs attendee): run the privacy crawl.
- A screen polls/refreshes while the user edits: run the edge pack.
- The owner tests it himself: run the owner-walk tracker so his clicks become a findings list without asking him.

## Eljárás
1. *Inputs (files, never inline secrets):* QA links file (`ROLE: https://...` one-click session links, e.g.
   `marveen/kops/crm/QA-LINKS.txt`, `marveen/strategy-day/app-links.txt`), a routes list, and for privacy a
   forbidden-terms list harvested from the owner-only records + one canary string. Use the QA preview/DB, not prod data.
   Never print or forward the links.
2. *Click-through (both roles x phone 390 + laptop 1366, + dark if the app has it):*
   `python3 -I ~/.claude/skills/app-ux-clickthrough-qa/clickthrough.py --links L.txt --routes routes.txt --out DIR
   --roles OWNER,PARTNER [--forbid forbid.txt --forbid-role PARTNER --control <canary>] [--dark]`
   routes.txt = `name<TAB>/path` or `name<TAB>#/hash`. It saves `<role>-<vp>-<nn>-<name>.png` per step + results.json
   and FAILs on horizontal scroll, page JS errors, 5xx, and (privacy) forbidden terms in rendered text OR network bodies.
   Then READ the PNGs yourself - the script proves nothing about looks.
3. *Journeys, not just routes:* for each role write a short scripted journey through the COMPLETE flow with a MIX of
   answer types (answer + skip + park + colleague) to the final send/done screen, on the phone. Pattern: the `check(name,
   cond)` PASS/FAIL style of `darryl/work/kops-poll/tests/portal_ui_walk.py` (390 light, 390 dark, 1366).
4. *Privacy crawl (Toby 10-21 method, all must pass):*
   - leak crawl: every partner-visible API response + DOM + localStorage/sessionStorage/globals contain 0 owner-only
     strings/ids; *positive control* (a joint canary) found, otherwise the crawl proved nothing.
   - differential: partner snapshot byte-identical before/after heavy owner-only edits; one joint edit must change it.
   - 404 parity: owner-only id vs random id give identical status/headers/body (incl. child ids, PATCH/DELETE with a JSON
     body - a 415 gate hit "proves nothing").
   - mass assignment: partner create/PATCH with scope/id/deal_id of an owner record is ignored.
   - owner-only bundle (e.g. ext.js) never requested by the partner browser, same 404 as an unknown path.
5. *Edge pack (reuse `marveen/kops/demo-spec-tool/qa-scripts/`):*
   - typing while the poll refreshes: type 40-100 keys at 150-200 ms while a background change lands; assert focus kept
     and every key in the field (`step4b_a18_typing_wipe.py`, `step4d_blkswitch.py`, `step4d_remount.py`).
   - race: tap into the field the moment the poll request is in flight (`expect_request`), then type (`step4c_n1race.py`,
     `step4d_n1d.py <field> [tries]`).
   - two devices / stale tab: phone draft, laptop saves newer, old phone tab saves -> the newer answer must survive
     (`step4d_stale2.py`); phone->laptop switch must not double a dictated transcript (MERGE-STEP4 finding 3).
   - parallel save: two contexts save the same record at once; exactly one wins or both merge, never silent loss.
   - "Elmentve" stays visible ~2 s; a refused action shows the real reason, never "try again" on a 403.
6. *Owner-walk tracker (he tests, I watch):* a one-shot dump of his activity rows run by a user timer, never a loop
   (`darryl/tools/owner-trace/dump.sh`: `wrangler d1 execute <db> --remote --json` on `crm_activity where user=<owner>
   and at >= <start>` -> Budapest times -> file). Read the file after his session; also read his in-app feedback rows.
   Write two files: `E2E-OWNER-TEST-<date>-raw.md` (timeline: HH:MM what he did, what the screen said, blocker) and
   `E2E-OWNER-TEST-<date>.md` = the *findings list A-R*: one letter per finding, priority order, each = symptom in his
   words/time + the rule that fixes it ("A. Where to start: ... Show the Demó on a new client"). Mark items fixed live
   during the test at the top. Corrections stay in place with "(corrected)" (item P).
7. *Review rounds per commit:* fetch into a scratch clone, run the repo tests (node + python, python tests as modules:
   `python3 -m tests.x` (verify per repo)), run the walk at 390/1366 (subagent OK), and append to ONE review file a
   section `## Re-check <sha> (<date>): SIGNED OFF | NOT signed off` with N fixed / partly / not fixed / new. Bus Darryl
   one line with the file path; re-arm the stall check (scheduled task, e.g. crm-build-watch) instead of polling.

## Buktatók
- Verify the bus line actually reached the builder: `GET /api/messages?from=marveen&status=failed` (pair breaker) -
  `delivered` is not seen (inter-agent-message-processing).
- A Playwright check that never reached the page (auth wall = 200 login page) passes "absence" checks: always include a
  positive control string.
- The DOM can say "fixed" while the pixels do not: read the screenshots (engineering-discipline-gates Gate 4).
- QA-only endpoints (`qa-login`) must 404 on prod; check it once per release.
- Clean up: archive QA test records afterwards and note the counts (Toby: "13 archived; owner 7 / partner 5").
- Laci uses phone AND laptop as primary (memory laci-phone-and-laptop): both widths are mandatory, not phone-only.
- Kill local `wrangler pages dev` servers by PID after use; leaked workerd trees ate 1.4 GB swap (darryl 10-02).

## Ellenőrzés
- results.json has 0 FAIL, and I opened the PNGs for every role x width.
- Privacy: forbidden terms 0 in DOM and network, positive control > 0, differential + 404 parity done.
- Edge pack: focus kept + all keys present in every typing test; newer answer survives the stale tab.
- Owner walk: raw timeline + A-R findings file exist, each finding has a fix rule, and the bus handoff is one pointer line.

---
name: drive-sharing-exposure-triage
description: A peer/agent flags that a Google Drive doc or folder is over-shared (sensitive content in an "anyone-with-link" location). Use to verify the real exposure via the Drive API, classify it, and decide act-now vs escalate-to-owner. Triggers on "X is in a semi-public folder", "anyone-with-link", "pricing/secrets visible in shared doc".
---

# Drive sharing exposure triage

## When to use
- A teammate flags sensitive content (pricing, comp math, secrets, PII, strategy) sitting in a shared/semi-public Drive location.
- Someone asks "is this doc/folder over-shared?" or "lock this down".
- You suspect an external party can reach an internal doc via a folder link.

## Procedure
1. **Verify, don't trust the description.** Find the file/folder id (`search_files`; results may overflow to a tool-results .txt — parse with python3, fields are under `title`/`id`/`parentId`/`mimeType`, NOT `name`). Then `get_file_permissions` on BOTH the folder AND the doc inside it.
2. **Classify the exposure precisely** from the permissions array:
   - `{"type":"anyone","role":"reader"}` = anyone with the link can VIEW.
   - `{"type":"anyone","role":"writer"}` = anyone with the link can **EDIT** (worse — they can alter the numbers, not just read). Always call this out explicitly; people underestimate it.
   - Named `type:user` grants (incl. service accounts like `*-drive@*.iam.gserviceaccount.com`) are separate — note that tightening `anyone` does NOT break a named grant (the automation path survives a lockdown).
   - A doc inherits folder sharing only if reachable via the folder link; direct file-links are independent.
3. **Decide act-now vs escalate.** Changing sharing scope on the owner's Drive is an outward-facing/access-control action:
   - The SCOPE decision (restrict to named people / view-only / strip content) belongs to the OWNER — humans may rely on the link for legit collaboration. Do NOT unilaterally flip it; escalate with verified facts + a concrete recommendation (e.g. "A: restrict to named people, C: strip pricing from any shareable copy").
   - For an ACUTE interim leak (external party may reach it NOW during a live-sensitive moment), a narrow reversible defensive restrict on the ONE doc can be justified — but **fact-gate it**: identify the single fact that determines whether the risk is real, get that fact, and only act if it confirms real-and-unresolvable risk.
4. **Fact-gate, don't fire mechanically.** Before any interim action, ask: is the "unknown" permanently unresolvable, or can the owner resolve it in an imminent review? Is the risk fresh or historical (months-old exposure isn't an emergency)? Is there actual evidence, or just absence-of-records? If the owner can resolve it soon and there's no evidence, HOLD and fold it into their one-pass decision — don't act on speculation.

## Pitfalls
- **You CANNOT change Drive sharing from the fleet.** The claude.ai Drive MCP AND Ryan's external write-proxy are both READ-ONLY on permissions: `get_file_permissions` exists, but there is NO share / permission-modify / delete-permission / reparent tool. So the sharing lockdown is the OWNER's manual ~10-sec Drive-UI action — route it there; do NOT promise "I'll lock it in seconds" (you can't). The only fleet-executable, reversible interim cover is to blank the CONTENT, not the sharing: `read_file` → save backup to local FS → `update_file` with a placeholder ("moved to an internal location") → `update_file` restore from backup on all-clear. Caveat: briefly blanks a live internal doc for any internal reader, so it's a stopgap, gated on the owner's explicit go, not the real fix.
- `search_files` output often exceeds the token cap → it saves to a tool-results .txt; parse with python3, NOT by re-reading whole. Field is `title`, not `name`.
- "anyone" usually means anyone-with-link (link-sharing), not search-discoverable, unless `allowFileDiscovery:true`. Say "anyone with the link" — accurate without overstating.
- Don't conflate "no record of who got the link" with "evidence they have access." Absence of records ≠ exposure.
- If you pre-declared an interim trigger to a peer, and the situation no longer meets the trigger's INTENT, say so explicitly when you stand down — reasoned restraint, not flakiness.
- Honor any "I'll hold until you say go" commitment you made to the owner; a reversible interim action still overrides that commitment, so only do it for genuine acute risk and tell them immediately.

## Verification
- Permissions verified by API on both folder and doc (not assumed from the flag).
- Exposure stated as viewer vs writer explicitly.
- Owner has the verified facts + a decision-ready recommendation; any interim action is reversible and reported.

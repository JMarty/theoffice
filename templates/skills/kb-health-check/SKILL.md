---
name: kb-health-check
description: Monthly audit of Pete's Obsidian knowledge vault — contradictions, broken links, stale cards, unsourced claims, coverage gaps, and new article candidates.
---

# KB Health Check

## When to use
- Monthly scheduled task fires (1st of each month, 09:00)
- Owner asks "audit the KB" / "health check" / "what's stale in the vault"
- After a burst of new cards (5+) to verify index consistency

## Procedure

### Phase 1 — Silent audit (always runs)

**Step 1: read current state**
```bash
ls ~/obsidian-vault/Knowledge\ Base/
ls ~/obsidian-vault/Knowledge\ Base/AI/
ls ~/obsidian-vault/Knowledge\ Base/Tooling/
ls ~/obsidian-vault/Knowledge\ Base/Business/
ls ~/obsidian-vault/Knowledge\ Base/SME/
ls ~/obsidian-vault/Knowledge\ Base/Philosophy/
ls ~/obsidian-vault/Knowledge\ Base/Misc/
cat ~/obsidian-vault/Knowledge\ Base/Knowledge\ Base\ —\ Index.md
```
Then read each card (Read tool).

**Step 2: run 7-stage audit**

1. *Contradictions* — claims in one card that contradict another on the same topic.
2. *Broken wikilinks* — `[[links]]` that don't resolve to an existing card filename.
3. *Orphaned cards* — cards not listed in the index, or in the index but file missing.
4. *Unsourced claims* — specific numbers/facts in "key takeaways" with no source URL or raw transcript to back them.
5. *Stale cards* — epistemic_status: seedling cards older than 90 days with no decision recorded. Flag for upgrade or archive.
6. *Coverage gaps* — topics referenced across cards (via [[wikilinks]] or "related" mentions) that have no card yet.
7. *New article candidates* — emerging themes across 3+ cards that deserve a synthesized entry.

**Step 3: decision loop audit**
Check each card's frontmatter for a `decision:` field. Cards without one (especially parked/skipped) are missing decision context. List them.

**Step 4: write audit report**
Save to `~/obsidian-vault/Knowledge Base/Misc/KB-health-check-YYYY-MM.md`:
```
# KB Health Check — YYYY-MM

Date: YYYY-MM-DD
Cards audited: N

## Contradictions
...

## Broken links / orphans
...

## Unsourced claims
...

## Stale cards (seedling > 90 days, no decision)
...

## Coverage gaps
...

## New article candidates
...

## Decision loop gaps (cards missing `decision:`)
...

## Actions taken
(filled in Phase 2)
```

Git commit and push the report: `git -C ~/obsidian-vault add -A && git -C ~/obsidian-vault -c user.name=pete -c user.email=contact-78be84@example.com commit -q -m "health-check: YYYY-MM audit report" && git -C ~/obsidian-vault push -q`

### Phase 2 — Interactive action (only when Owner is present / triggered manually)

After Phase 1, send the summary to Owner via `office-say` (THE ONLY VALID CHANNEL — never use slack_send_message or any Slack MCP tool; that reaches a different (work) workspace, not the Office):

```bash
office-say "KB health check done. Found: N contradictions, N broken links, N stale cards, N coverage gaps. Action all, action [list], or park the report?"
```

On "action all" or a specified list: fix broken links in-place, upgrade stale seedling cards to budding/evergreen if content warrants, create stub cards for coverage gaps, and add new article candidates as seedling cards.

For scheduled (unattended) runs: complete Phase 1 only, notify Owner via office-say with the summary line, and wait for a manual "action" reply before touching any card content.

## Pitfalls
- **CHANNEL RULE (hard stop):** ALL Owner communication uses `office-say`. NEVER use `slack_send_message`, `slack_send_message_draft`, or any Slack MCP tool to reach Owner — the claude.ai Slack MCP connector points at a different (work) workspace, not the Office. Sending there leaks internal fleet information.
- Don't edit wiki files autonomously in unattended runs — Phase 1 only, notify and wait.
- Broken wikilinks: the `[[filename]]` must exactly match the `.md` filename without the `.md` extension. Case-sensitive on Linux.
- "Stale" = seedling AND older than 90 days AND no `decision:` field. Don't flag budding/evergreen cards as stale.
- If the index and the file system disagree, the file system wins. Update the index to match.
- Keep the health check report in Misc/, not in a topic folder. It's maintenance, not knowledge.

## Verification
- Audit report written to Misc/ and git-committed
- Owner notified via office-say with the finding counts
- No card content changed in unattended runs

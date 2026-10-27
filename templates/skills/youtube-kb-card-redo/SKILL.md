---
name: youtube-kb-card-redo
description: Redo an existing Obsidian KB card from a YouTube link by re-extracting the transcript, checking prior coverage, verifying external claims against primary sources, replacing the card, updating the index, and committing the vault.
---

# YouTube KB Card Redo

## When to use

- The owner says "redo this" about a YouTube link.
- A card already exists in the vault, but it needs to be rewritten or corrected with source criticism.
- The video contains fresh news, a policy claim or a market conclusion that needs to be verified.

## Procedure

1. Find the existing card by video ID:
   ```bash
   rg -n "VIDEO_ID|youtube URL" ~/obsidian-vault/Knowledge\ Base
   ```
2. Check memory for the same keyword to see whether there is a pending decision or earlier routing.
3. Re-extract the full YouTube transcript:
   ```bash
   ~/.knowledge-scout-venv/bin/python -c "from youtube_transcript_api import YouTubeTranscriptApi; f=YouTubeTranscriptApi().fetch('VIDEO_ID', languages=['en','hu']); print(' '.join(sn.text for sn in f))"
   ```
4. If the video asserts a current fact or news, verify it against a primary source or a reliable recent article. In the card, separate:
   - verified facts
   - video claims
   - inference / judgment
   - fleet implications
5. Rewrite the card in adaptive form. Do not just polish the old one if its flaw is structural.
6. Update the `Knowledge Base — Index.md` line to reflect the new decision hook.
7. If a decision is still pending, save it to hot memory.
8. Commit + push:
   ```bash
   git -C ~/obsidian-vault add -A
   git -C ~/obsidian-vault -c user.name=pete -c user.email=contact-78be84@example.com commit -q -m "card: <title>"
   git -C ~/obsidian-vault push -q
   ```

## Pitfalls

- Do not repeat the tone of the old card. Redo means re-reading the source.
- YouTube macro-panic content often mixes real facts with oversized conclusions. Separate them.
- If it contains a fresh policy or market claim, do not rely on the transcript alone.
- Keep the raw transcript at the end of the card so it can be audited later.

## Verification

- Only one active card remains for the video ID.
- The card frontmatter, index line and memory all state the same decision status.
- The verified section relies on a primary source, not on the narrator's claim.
- The vault commit and push completed.

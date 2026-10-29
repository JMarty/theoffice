---
name: deploy-static-page-cloudflare
description: Build a standalone HTML page and deploy it to Cloudflare Pages as a clean public URL the owner can send to third parties (better than a claude.ai artifact for that). Use when the owner wants a shareable website / landing / prep page on pages.dev, or to redeploy an edited page to the same URL.
---
# Deploy a static page to Cloudflare Pages

## When to use
- The owner wants a shareable PUBLIC web page (prep page, landing page, guide) hosted on Cloudflare, not a claude.ai artifact (artifacts are private-by-default + look internal).
- Redeploying an edited page to the same URL.

## Procedure
1. Build a COMPLETE standalone HTML doc: doctype, html, head (meta charset + viewport, title, description, emoji favicon as SVG data-URI), body. If you already have an artifact-body version (just `<style>` + content, no doctype), wrap it: prepend a `<head>` block, append `</body></html>`. Put it as `index.html` in its own dir.
2. Source CF creds (token needs Pages:Edit). Fleet's working one:
   `set -a; . <project>/deploy.env; set +a` (sets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).
3. FIRST TIME ONLY, create the project (the token does NOT auto-create on deploy):
   `npx wrangler pages project create <name> --production-branch=main`
4. Deploy: `npx wrangler pages deploy <dir> --project-name=<name> --branch=main --commit-dirty=true`
   Production URL = `https://<name>.pages.dev/`.
5. VERIFY: curl the production URL -> expect HTTP 200 + grep for expected content strings. Don't say done until verified.
6. Save the standalone HTML durably (project root, e.g. `<old-install>/<NAME>.html`), not just scratchpad, so it survives resets and stays redeployable.

## Pitfalls
- `wrangler` is NOT on PATH; use `npx wrangler` (v4.x).
- Project must PRE-EXIST (step 3) or deploy errors "The Pages project <name> does not exist."
- The bare `<name>.pages.dev` is the shareable production URL; VERIFY that one. The per-deploy hash subdomain (`<hash>.<name>.pages.dev`) can briefly return 000 (DNS lag) - ignore it.
- Redeploy = the same deploy command; keeps the same URL. No auto-deploy pipeline needed for a rarely-changing page.
- Fully public (no login) unlike a claude.ai artifact - correct for sending to third parties.
- FUNCTIONS TRAP (only if the page has Pages Functions, i.e. a `functions/` dir + `wrangler.toml`): you must deploy FROM the dir that contains them (`cd that-dir && wrangler pages deploy .`) so wrangler compiles them (output shows "Compiled Worker" + "Uploading Functions bundle"). Deploying from a PARENT/repo-root path (`wrangler pages deploy subdir`) ships STATIC ASSETS ONLY and silently drops the functions -> every POST /api endpoint 405s. Pure-static pages (no functions) are unaffected. This bug broke the an app's /api for ~22h.

## Verification
- `<name>.pages.dev` returns 200 + expected content; durable source saved to project root.

---
name: html-report-render
description: Build a polished, MOBILE-FIRST HTML report for Owner and render it to a crisp PNG. Use whenever an agent produces a visual report/dashboard/briefing as HTML for Owner (spend analysis, summaries, infographics). Owner reads on his phone, so desktop-only layouts look broken.
---
# HTML report → PNG (mobile-first)

## When to use
Any time you build an HTML report/infographic for Owner and want to send it as an image (and the HTML). He opens it on a PHONE — a desktop-width layout wraps numbers into a "ransom note" and looks ugly (a desktop-layout report that was sent as an image looked ugly on the phone).

## Procedure
1. Write the HTML self-contained (inline `<style>`), dark theme reads as premium. Target a ~700px content column (`.wrap{max-width:680px}`), `body{padding:16px}`.
2. **Mobile-first layout rules (the whole point):**
   - Stat cards: `display:grid;grid-template-columns:repeat(2,1fr)` (2×2, NOT 4-across). On the value: `white-space:nowrap;font-variant-numeric:tabular-nums;font-size:~19px`. This stops "<amt> Ft" wrapping char-by-char.
   - Bar rows: label + value on row 1, full-width thin track (~9px) on row 2. Use one element with `grid-template-areas:'l v' 't t'` so you keep simple 3-child markup.
   - Tables: font ~12px, compact padding (~7px), let the name column wrap, `white-space:nowrap` + right-align on number cells.
   - Numbers everywhere: `font-variant-numeric:tabular-nums`.
3. **Render full-page PNG with Playwright** (chromium is cached at `~/.cache/ms-playwright`, e.g. `chromium-1223`):
   ```bash
   python3 -m venv /tmp/r/venv && /tmp/r/venv/bin/pip install -q playwright pillow
   ```
   ```python
   from playwright.sync_api import sync_playwright
   with sync_playwright() as p:
       b=p.chromium.launch(); pg=b.new_page(viewport={"width":712,"height":1200}, device_scale_factor=2)
       pg.goto("file:///abs/report.html"); pg.wait_for_timeout(400)
       pg.screenshot(path="/abs/report.png", full_page=True); b.close()
   ```
4. **Verify before sending**: crop the top ~900px with PIL and Read the crop — confirm the stat numbers sit on one line. Don't send unseen.
5. Send via telegram reply with `files:[png, html]`. The PNG views inline on his phone; the HTML reflows if he taps it.

## Pitfalls
- 4-column stat grids are the #1 ugliness on mobile → always 2 columns + nowrap values.
- `chrome-headless-shell --screenshot` only captures the viewport, not the full page → use Playwright `full_page=True` instead.
- `pip install` fails with PEP 668 (externally-managed) → use a venv, not --user.
- Don't re-author validated numbers when only restyling — edit the CSS block, keep the body/data untouched.
- Telegram rejects tall PNGs as photos with `PHOTO_INVALID_DIMENSIONS` when `width + height > 10000` px. A full-page report at scale 2 easily exceeds this (e.g. 1424×10464). Before sending, downscale so `w+h ≤ ~9200`: `from PIL import Image; im=Image.open(p); sc=9200/sum(im.size); im.resize((int(im.size[0]*sc),int(im.size[1]*sc)),Image.LANCZOS).save(send_path)`. Still crisp on a phone. Always attach the HTML too.

## Verification
- Cropped header screenshot shows big numbers on single lines, cards aligned.
- PNG is full-page (tall), not cut off at viewport height.

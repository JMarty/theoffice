---
name: demo-video-recorder
description: Record a click-through demo video of a web app with Playwright - Hungarian caption bar, visible orange cursor with click pulse, real typing, the AI wait cut out (segment per stretch, hidden helper page polls), ffmpeg concat to one 1920x1080 mp4. Use when a client demo (a client app, a client app, the client app style) or any app needs an intro/walkthrough video, "csinálj videót a demóról", "I want to see where you click and what you type".
---
# Demo video recorder (Playwright + ffmpeg)

Built for two client demos and generalised. Each client keeps its own `<client>/video/record.py`; a copy of the shared helper is in `references/common.py` in this skill.

## Mikor használd
- A client demo is verified and the owner wants a video of it (shot list with captions, 2-4 min, no audio).
- Not before the demo itself passed its own checks (`kops-client-demo-build`): every take writes real data to the app.

## Eljárás
1. **Shot list first** (`<client>/video/VIDEO-PLAN.md`, model `kops/sprint/video/VIDEO-PLAN.md`): numbered shots, the Hungarian caption for each, what is clicked/typed. Fictional data only; the input letter/email is a test fixture you wrote.
2. **Script** `<client>/video/record.py` (copy the the client app one, it is the cleanest):
   - Top: `B` (base URL), `W, H = 1920, 1080`, `RAW = <here>/raw`, `CAP = {key: "caption"}`, login secret read from a file (`LOGINS.txt`), `DRY = "--dry" in sys.argv`. Then `exec(open("common.py").read())` (common.py expects `W, H, RAW, CAP` to exist).
   - `common.py` gives: `OVERLAY_JS` (caption bar `#dcap`, cursor ring `#dcur` with mousedown shrink + `.dpulse` ripple, orange focus glow on inputs), `log()`, and class `Seg` = one browser context with `record_video_dir`, `accept_downloads=True`, `dialog -> accept`. Helpers: `cap(key, hold)`, `wait(s)`, `hover`, `click` (moves the mouse in steps, re-measures the box before clicking), `type(sel, text, delay)`, `select`, `scroll`/`scroll_to` (eased), `btn(text)` (xpath for button/link by text). `close()` renames the clip to `raw/segNN.webm`.
   - Login once in a non-recorded context `c0`, keep `state = c0.storage_state()`, and use its page as the **helper** for polling and API reads.
3. **Cut the AI waits:** end the segment right after the action that starts the AI job (`s.cap("wait")` caption "kb. 1 perc ... kivágtuk" first), `s.close()`, poll in the helper page until the job is done (`wait_idle` in a client app: reload every ~8 s, look for busy texts; `wait_intake` in the client app: check the row for "AI dolgozik"; both with a 420 s timeout that raises), then open a new `Seg` and resume.
4. **Answer the AI's follow-up questions** with a keyword->answer table (`ANSWERS` + `answer_for(q)`); dismiss ("the dismiss button") any question with no match so the run never blocks.
5. **End card:** `pg.set_content(<branded HTML>)`, re-inject the overlay, hold ~5 s.
6. **Concat:**
   ```
   ffmpeg -y -loglevel error -f concat -safe 0 -i raw/list.txt -r 30 -c:v libx264 -pix_fmt yuv420p -crf 23 -preset medium <client>-demo.mp4
   ```
   (`list.txt` = `file '<seg>'` lines, sorted.) The script clears `raw/` at start.
7. **Run:** `cd <client>/video && timeout 1500 python3 record.py > takeN.log 2>&1` (plain `python3`: Playwright lives in the user site-packages, so `python3 -I` cannot import it). Log every created id (orders/projects) so the purge after the take is exact.
8. **Watch it yourself** before anyone else (frame check added 2026-11-01, not part of the 10-16/17 runs; verify it fits): extract a few frames (`ffmpeg -ss <t> -i <mp4> -frames:v 1 f.png`) at each caption and check the caption is visible, the cursor is on the thing being clicked, and no test data leaks. Then Drive + owner link (memory `kops-docs-in-drive`).

## Buktatók
- **Dry-run every later step on leftover data before burning a clean take** (a client app 10-16: 3 failed takes and 3 data wipes in one night). Run with `--dry` or against the previous take's data until the whole script passes, then purge and record.
- **Accept `confirm()` dialogs**: `pg.on("dialog", lambda d: d.accept())` on every context, including the helper. It was one of the three lessons from the 3 failed a client app takes.
- **The AI phrases follow-up questions differently every run, so pre-answer them in the input letter.** Put every fact it could ask for (date, size, contact, logo/photos) into the letter, and keep the keyword table as a backstop.
- **Captions behind `<dialog>`:** a modal dialog is in the top layer, so a caption under `document.documentElement` is hidden. `common.py` re-parents `#dcap` and the cursor into `dialog[open]` on every call and re-creates the caption if a re-render removed it (the client app lesson).
- **Every take creates data on prod.** Budget a purge per take (Darryl, with a backup). Before/after id sets from the helper (`/api/state`) tell you exactly what to purge.
- **Dry-run selectors against the app JS** (grep the labels). Accents matter: the button is "Próbászámla", not "Próbaszámla".
- Late layout shifts (map tiles, lazy cards) move targets: `click()` re-measures before pressing; add a `wait` after navigation.
- Hide earlier test records from the picture with a DOM-only filter in the overlay (the `ZZZNEVERMATCH` regex line in `common.py` is a per-client placeholder: set it to your test-record pattern or delete it). Never delete real data for a nicer shot.
- Long texts (the inquiry letter) are pasted/uploaded, not typed; the caption says so. Typing speed ~45-55 ms/char for short fields.
- 1920x1080 needs `--force-device-scale-factor=1 --hide-scrollbars` on launch, and `record_video_size` equal to the viewport.

## Ellenőrzés
- `takeN.log` ends with `DONE <mp4>` and no `TIMEOUT` / `JS ERROR` lines.
- Frame checks at each caption pass (visible caption, visible cursor, no "teszt"/internal names on screen).
- Duration within the plan (2-4 min); the AI wait shows only as the "kivágtuk" caption.
- Data created by the take is listed in the log and purged (or deliberately kept) after Darryl confirms.

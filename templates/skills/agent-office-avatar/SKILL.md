---
name: agent-office-avatar
description: Give a fleet agent its real Office-character profile picture (not a generic gallery cartoon). Use when an agent has no avatar, has the wrong/cartoon avatar, or a new agent was just created. Each agent should match its Office persona's actual face.
---
# Agent Office-character avatar

## When to use
- Owner says an agent "has no profile picture" or "doesn't match the others"
- A new agent was created and needs its face
- Someone set a generic gallery cartoon instead of the real Office character

## Key facts
- The fleet convention: agents use REAL Office character faces, NOT the cartoon gallery in web/avatars/.
- Source faces cached in /tmp/office-avatars/ (michael=marveen, oscar=cfo, dwight, jim, pam, andy, kevin, darryl). Toby etc. may be missing -> source fresh.
- The Telegram bot profile pic IS set programmatically via the Bot API method `setMyProfilePhoto` — NO BotFather, NO manual step. (Verified 2026-05-28; the dashboard's BotFather-instruction message is the OLD/lazy path — don't rely on it.) The bot token is in `agents/<name>/.claude/channels/telegram/.env`.

## Procedure
1. If the face is in /tmp/office-avatars/, use it. Otherwise source it:
   - Fandom API: `curl -s -A "<browser UA>" "https://theoffice.fandom.com/api.php?action=query&titles=<Character%20Name>&prop=pageimages&piprop=original&format=json"` -> parse `.query.pages[].original.source`.
   - Download with the same browser UA (plain curl gets 403 on static.wikia.nocookie.net).
2. The download is often WebP despite a .jpg name. Convert to PNG: `ffmpeg -y -i in out.png` or PIL. Verify with `file`.
3. Read the image to CONFIRM it is the right character before applying.
4. Place at `agents/<name>/avatar.png` (dashboard display avatar; findAvatarForAgent picks up avatar.*).
5. Set the actual Telegram profile pic via the bot's own token:
   ```
   TOKEN=$(grep -oh "[0-9]\{8,\}:[A-Za-z0-9_-]\{30,\}" agents/<name>/.claude/channels/telegram/.env | head -1)
   curl -s "https://api.telegram.org/bot${TOKEN}/setMyProfilePhoto" \
     -F 'photo={"type":"static","photo":"attach://p"}' \
     -F "p=@agents/<name>/avatar.png"
   ```
   Expect `{"ok":true,"result":true}`. `photo` is an InputProfilePhoto object; the file is attached via `attach://`.

## Reverse sync: dashboard avatars FROM Telegram (bulk)
When the dashboard shows grey initials but the bots already have Telegram photos ("make dashboard match Telegram"), pull each bot's current photo and drop it at `agents/<name>/avatar.png`:
```
# per agent: token from agents/<name>/.claude/channels/telegram/.env; bot_id = token.split(':')[0]
getUserProfilePhotos?user_id=<bot_id>&limit=1  -> result.photos[0][-1].file_id  (last = largest)
getFile?file_id=<id>                           -> result.file_path
download https://api.telegram.org/file/bot<TOKEN>/<file_path>  -> agents/<name>/avatar.png
```
findAvatarForAgent then serves it; dashboard hasAvatar flips true. Verify each downloaded file is a real image (`file`), not an error page.

PRIMARY agent (Michael Scott / marveen) is DIFFERENT from workers:
- Dashboard avatar path = `store/marveen-avatar.png` (served at /api/marveen/avatar; default fallback is web/avatars/01_robot.png — the robot = "no avatar set").
- Its Telegram bot token is in the GLOBAL `~/.claude/channels/telegram/.env` (bot <name>), NOT under agents/.
- To fix: cp the real face to store/marveen-avatar.png AND setMyProfilePhoto on the global token so dashboard + Telegram match. (Real Michael face: /tmp/office-avatars/michael.png.)

## "Head is cut off / faces are tiny" — head-clearly-visible requests
When Owner says a face is cut off or too small, the avatar is a full-body promo shot. The Fandom LEAD image (`pageimages original`, often `Character_-_X.PNG`) is the LOW-RES full-body version (e.g. 449x899) — useless for a headshot. There is a matching HIGH-RES promo set (2249x3000, newspaper background) under plain file names. Crop the head from those:
- `Pam_Beesley.jpg`, `Jim.jpg`, `Ryan_Howard.jpg`, `Oscar_Martinez.jpg`, `2009Kevincropped.PNG`, Andy=`<uuid>.jpeg`.
- Find any of them: `api.php?action=query&titles=File:<Name>&prop=imageinfo&iiprop=url|size&format=json`; pick the 2249x3000 result.
- Crop face-centered square with PIL: side ≈ 0.58-0.70 * width, center_x ≈ 0.44-0.55, center_y ≈ 0.17-0.32 (faces sit in the upper third of these studio portraits), resize 640x640 LANCZOS. Read to verify before applying.
- Verified working crop params (2026-05-29): ryan(0.50,0.18,0.58) jim(0.52,0.17,0.60) pam(0.44,0.22,0.62) andy(0.52,0.30,0.66) kevin(0.47,0.32,0.70) cfo(0.55,0.30,0.66).

## Pitfalls
- /tmp/office-avatars cache is CLEARED ON REBOOT — don't assume it's populated; re-source from Fandom.
- WebFetch gets 403 on fandom.com -> use the api.php endpoint with a browser User-Agent via curl, not WebFetch.
- Wikia image downloads need a browser UA or they 403.
- The .jpg from wikia is actually WebP -> Telegram/dashboard want PNG/JPG, convert first.
- Do NOT use the cartoon gallery (web/avatars/NN_*.png) for a persona that has a real Office face. Owner will notice. (Correction 2026-05-28: gave Toby a cartoon detective, had to redo with the real face.)
- Do NOT tell Owner to do BotFather /setuserpic himself. That was wrong — `setMyProfilePhoto` sets it directly. (Correction 2026-05-28: I claimed there was no API method; there is. Owner never does it manually.)
- `setMyProfilePhoto` needs `photo` as a JSON InputProfilePhoto (`{"type":"static","photo":"attach://x"}`) + the file as a separate multipart field; a plain `-F photo=@file` returns 400 "photo isn't specified".

## Verification
- `file agents/<name>/avatar.png` shows a valid PNG.
- Read the image -> it is the correct Office character.
- setMyProfilePhoto returned `{"ok":true}`; confirm with `getUserProfilePhotos?user_id=<bot_id>` (total_count >= 1).

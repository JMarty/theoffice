---
name: local-meeting-transcribe
description: Zero-token transcription of a recorded call/meeting on the server (faster-whisper Hungarian + ECAPA 2-speaker split), memory-capped with systemd-run, uploaded to Drive as a Google Doc, then a manual speaker-label review. Use when the owner sends/uploads a call recording (mp4/mp3/m4a, the office client call, Laci call, Haris, a client) and wants a transcript, a summary or action points, or says "írd le a hívást", "transcribe this", "who said what".
---
# Local meeting transcription (no Claude tokens)

Proven twice: Laci call 2026-10-26 (1h45, 11 chunks, ~61 min Whisper + ~18 min speaker split) and Haris call 2026-10-29 (2 chunks, 725 s). Memory: `local-transcription-recipe`. Working folder: `/opt/claude/theoffice/tenant/agents/marveen/transcripts/`.

## Mikor használd
- A recording of a call arrives (Slack upload lands in `agents/marveen/inbox/`, or a Drive link) and he wants the text, a summary, or action points.
- Any the office discovery/consultation recording (the demo-intake rule says consultations get recorded; the transcript feeds `kops-demo-intake`).
- Not for: a short voice note (`[Hang átirat]:` is already text).

## Eljárás
1. **Audio only.** If he still has the raw screen capture, the owner-side extract that works is
   `ffmpeg -i "<file>.mp4" -vn -ac 1 -b:a 64k out.mp3` (VLC "convert" broke on Windows screen captures). Server side, ffmpeg reads the mp4/mp3 directly.
2. **Chunk** into 10-minute 16 kHz mono WAVs (one chunk in memory at a time; the box is 8 GB and shared with the fleet):
   ```bash
   D=/opt/claude/theoffice/tenant/agents/marveen/transcripts; mkdir -p $D/<name>-chunks
   ffmpeg -loglevel error -y -i <inbox file> -ac 1 -ar 16000 -f segment -segment_time 600 $D/<name>-chunks/c%02d.wav
   ```
   Names must be `c00.wav, c01.wav, ...`: the transcriber and diarizer compute timestamps as `chunk index x 600 s`.
3. **Transcribe** with the generic script, in a memory-capped user unit (never inline in your own session, never uncapped):
   ```bash
   systemd-run --user --unit=<name>-transcribe --nice=10 -p MemoryMax=2500M -p MemorySwapMax=300M \
     /opt/claude/theoffice/tenant/agents/darryl/work/kops-demoterv/.venv/bin/python \
     $D/transcribe_generic.py $D/<name>-chunks $D/<name>-<YYYY-MM-DD>
   ```
   `transcribe_generic.py`: faster-whisper `large-v3-turbo`, int8, 2 CPU threads, `language='hu'`, VAD (min silence 500 ms, pad 300 ms), `condition_on_previous_text=False`, `beam_size=2`; model dir `agents/darryl/work/kops-demoterv/data/whisper`. Writes `<out>.txt` (`[HH:MM:SS] text` per line) and `<out>.progress` (`chunk i/N done, S s elapsed`, then `DONE`).
4. **Release the session.** Do not poll in a foreground loop (FLEET RULE 1). Read `<out>.progress` when you are next woken or arm a one-off check (memory `arm-a-check-when-awaiting-a-reply`). Rough speed: ~35 s of compute per minute of audio on 2 threads.
5. **Speaker split (2 voices)**, venv `transcripts/diar/.venv`, ECAPA model cached in `transcripts/diar/ecapa`:
   - `diar/diarize.py` is the Laci-specific version: copy it, then change `B` (output base), the chunk dir (`chunks` -> `<name>-chunks`), the anchor phrase (`'megfáztam'`) and the two names. Method: one ECAPA embedding per transcript line (line end = next line's start, capped 20 s; lines under 0.8 s inherit the previous speaker) + 2-cluster agglomerative (cosine, average).
   - `diar/preview.py` writes `<base>.speakers-preview.txt` for a quick look. Run it first, show the owner a few lines, and ask which voice is him if it is not obvious. Then anchor the mapping on one line you KNOW is his.
   - Run capped: `systemd-run --user --unit=<name>-diarize --nice=10 -p MemoryMax=2000M -p MemorySwapMax=300M <diar venv python> <your copy>.py`. `diar/after_whisper.sh` is the no-LLM chainer (waits for the Whisper output, gives up after 3 h, then execs the diarizer).
6. **Drive Google Doc.** Upload as a Google Doc with the `drive.file` token `/opt/claude/marveen/marveen/.gmail-creds/.oauth2.drive.k.the service user@gmail.com.json`: multipart upload with `mimeType: application/vnd.google-apps.document` (create), and a `PATCH .../upload/drive/v3/files/<id>?uploadType=media` with `text/plain` to replace the content in place (same link). Keep the returned `{id, webViewLink}` in `<base>.doc.json`. Pattern: `laci_transcribe.py` (bottom) and `diarize.py` (bottom). Header line: what it is, date, "local Whisper, Hungarian, unedited" and that the speaker labels are automatic.
7. **Manual speaker review (me, not a subagent).** Back up first (`cp <base>.speakers.txt <base>.speakers.txt.bak-auto`), then read the transcript and fix the lines where one sentence was split between speakers. The Laci run needed 10 fixes out of ~1,800 lines, all short back-and-forth fragments (e.g. "amit megegyeztünk a 600" at 01:19:47 was Laci answering). Push the corrected text to the same Doc and add "speaker labels reviewed" to the header.
8. **Deliver.** Owner gets the Doc link on Slack (office-say), plus summary + action points if he asked (the Laci summary went to a separate Doc). For the office calls also mirror the facts into the CRM (memory `crm-mirror-every-change`; no internal process in joint deals) and use the transcript as the source for `kops-demo-intake` questions.

## Buktatók
- **Uncapped run filled swap to 100%** (10-26, Darryl flagged it). Always `MemoryMax` + `MemorySwapMax`; one chunk in RAM at a time.
- **`office-say` is NOT on PATH inside a systemd-run unit.** `laci_transcribe.py` and `diarize.py` call `office-say` by bare name and silently did nothing there. Use the absolute path (`/home/the service user/.local/bin/office-say`, verify it posts from a unit) or notify yourself after reading `.progress`.
- The 10-26 first attempt passed the mp3 straight to `laci_transcribe.py` with `MemoryHigh=3G`; the working version takes the CHUNK DIRECTORY. Don't feed it a file.
- Whisper output is unpunctuated-ish and mishears names; never quote a figure or a name from it to the owner or a client without checking the audio context or another source.
- 2-cluster split assumes exactly two speakers. With 3+ people the labels are not usable as-is: say so, and label by context or leave unlabeled.
- Speaker naming: confirm which voice is the owner from the preview, then anchor by a known line. Never guess and publish.
- Gemini / a paid transcription API were the 10-20 plan (owner's choice for the a client call); this local path is the zero-token default since 10-26. Use a paid API only if he asks (verify his current preference).
- Recordings and transcripts of client calls are confidential: Drive (his account) and the transcripts folder only; no transcript text on the bus.

## Ellenőrzés
- `<out>.progress` ends with `DONE` (generic script) or the Doc json exists; line count of `<out>.txt` is plausible (Laci: ~1,800 lines for 1h45).
- Last timestamp in the transcript is close to the recording length (a missing chunk shows up as a gap).
- The Doc opens from `webViewLink` and its text matches `<base>.speakers.txt` after the review.
- `systemctl --user status <unit>` shows it ended; no leftover unit hogging memory.

---
name: slack-file-send
description: Send a real FILE (PDF, image, doc) to the owner on Slack as the agent. Use whenever the owner asks for a file/PDF/attachment, or you generated a document to deliver. office-say only posts TEXT; this is how you attach a file. Works since the Slack app was granted files:write (2026-06-17).
---
# Slack file send (agent -> owner)

## When to use
- The owner asks for a PDF / file / "send it as a file" / a more shareable format.
- You generated a document (report, slide PDF, export) and need to deliver it in Slack.
- Prefer this over email for file delivery (email is the fallback if this ever fails).

## Procedure
1. **Bot token** = the value starting `xoxb-` inside `<tenant>/secrets/slack/<agent>.json` (search recursively; the JSON nests it). For marveen: that file.
2. **Channel** = read `tenant/agents/<agent>/.reply-context` (the owner DM channel, e.g. marveen = `<slack-id>`). Or `$OFFICE_REPLY_CHANNEL`.
3. **Slack external upload, 3 steps, all with `Authorization: Bearer <token>`** (form-urlencoded):
   - `POST https://slack.com/api/files.getUploadURLExternal` with `filename` + `length` (file size in bytes) -> returns `upload_url` + `file_id`.
   - `POST` the **raw file bytes** to `upload_url` (Content-Type `application/octet-stream`). Expect body `OK - <size>`.
   - `POST https://slack.com/api/files.completeUploadExternal` with `files=[{"id":file_id,"title":"..."}]` (JSON string), `channel_id`, optional `initial_comment`.
   - Every step must return `ok: true`.
4. The file appears in the channel as a post from the agent (with the initial_comment as caption). No separate office-say needed, but a short office-say note is fine.

## Pitfalls
- `office-say` is TEXT ONLY (`/api/outbound` enqueues text); it cannot attach files. Do not try to pass a path to it.
- The old `files.upload` API is deprecated; use the `getUploadURLExternal` + `completeUploadExternal` flow above.
- `length` must be the exact byte size, else the upload URL rejects.
- `files=` must be a JSON-encoded string, not a raw object, in the urlencoded body.
- If files:write scope is ever missing, completeUploadExternal returns `ok:false` with an error like `missing_scope` -> fall back to email (Gmail send via the Owner OAuth creds with mail.google.com scope).

## Working snippet
```python
import json, os, urllib.request, urllib.parse
def find_token(o):
    if isinstance(o,str): return o if o.startswith("xoxb-") else None
    if isinstance(o,dict):
        for v in o.values():
            t=find_token(v)
            if t: return t
    if isinstance(o,list):
        for v in o:
            t=find_token(v)
            if t: return t
    return None
TOKEN=find_token(json.load(open("<tenant>/secrets/slack/<agent>.json")))
CHAN=open("<tenant>/agents/<agent>/.reply-context").read().strip()
PDF="/path/to/file.pdf"; size=os.path.getsize(PDF)
def api(m,p):
    r=urllib.request.Request("https://slack.com/api/"+m,data=urllib.parse.urlencode(p).encode(),
        headers={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/x-www-form-urlencoded"})
    return json.load(urllib.request.urlopen(r,timeout=30))
r1=api("files.getUploadURLExternal",{"filename":os.path.basename(PDF),"length":size})
urllib.request.urlopen(urllib.request.Request(r1["upload_url"],data=open(PDF,"rb").read(),
    headers={"Content-Type":"application/octet-stream"}),timeout=60).read()
api("files.completeUploadExternal",{"files":json.dumps([{"id":r1["file_id"],"title":"Title"}]),
    "channel_id":CHAN,"initial_comment":"Caption text."})
```

## Verification
- All three Slack calls return `ok:true`; the middle POST returns `OK - <bytes>`.
- The file shows up in the owner's DM with the caption.

## Bonus: generating PDFs with non-ASCII text
Build PDFs with reportlab (installed); to render characters such as Hungarian ő/ű embed the DejaVu font
(`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` + `-Bold`). There is no browser or LibreOffice on the box.
Portrait (9:16, ~540x960) with large type = phone-friendly; landscape (16:9, ~960x540) = for presenting.

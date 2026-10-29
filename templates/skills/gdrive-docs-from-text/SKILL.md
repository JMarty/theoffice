---
name: gdrive-docs-from-text
description: Create a Google Drive folder and create/update Google Docs in it from plain text via the Drive API, using the drive OAuth creds. Use to build or keep a shareable Drive folder of project docs for the owner without touching the Docs UI.
---
# Google Drive folder + Docs from text

## When to use
- The owner wants project material captured as editable Google Docs in a Drive folder.
- Updating an existing Doc's content in place (keeps its URL).

## Key facts / how
- Auth: refresh the drive OAuth token at `<tenant>/secrets/.gmail-creds/<account>.json` (POST token_uri, grant_type=refresh_token -> access_token).
- CREATE FOLDER: `POST https://www.googleapis.com/drive/v3/files` body `{"name":..,"mimeType":"application/vnd.google-apps.folder"}` (+ `?fields=id,webViewLink`).
- CREATE A DOC FROM TEXT: multipart `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` with part1 = JSON `{"name":..,"mimeType":"application/vnd.google-apps.document","parents":["<folderId>"]}` and part2 = `text/plain` content -> Drive converts the text into a Doc.
- UPDATE A DOC IN PLACE (keep its URL): `PATCH https://www.googleapis.com/upload/drive/v3/files/{docId}?uploadType=media` with `Content-Type: text/plain` body -> re-converts + replaces the whole content. WARNING: overwrites any manual edits; only safe for docs you author + control, and when the owner hasn't been editing them.

## Pitfalls
- text/plain -> Doc conversion does NOT render markdown: strip `*` and `#` markers, use plain structure (UPPERCASE headers, blank lines, `-`/`·` bullets).
- Do NOT hand-author the JSON payload in a bash heredoc - newlines/apostrophes in the content break it ("Expecting ',' delimiter"). Build the payload in python (`json.dumps`) and POST via urllib.
- Mirror each doc locally (project root `.md`) so it survives resets.
- Docs are created in Owner's Drive (owner owns them); private unless shared.

## Verification
- The returned webViewLink opens; content correct; local mirror saved.

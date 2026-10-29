---
name: slack-file-upload
description: Send a real FILE (Word/PDF/PNG/xlsx/zip) to Owner on Slack from inside an agent session. Use whenever a deliverable is a file, not text - office-say only posts text and cannot attach. Works for any agent.
---
# Upload a file to Owner on Slack

## When to use
- You produced a file (.docx, .pdf, .png, .xlsx, .zip...) and Owner needs the actual file, not pasted text.
- `office-say` posts text only - it has NO attachment path. This is the file path.

## Procedure
1. Reply channel (the DM): `cat $OFFICE_TENANT_ROOT/agents/$OFFICE_AGENT_ID/.reply-context` -> e.g. `<slack-id>`.
2. Bot token: `$OFFICE_TENANT_ROOT/secrets/slack/<agent>.json` -> field `botToken` (starts `xoxb-`). Keys in that JSON: appToken, botToken, botUserId.
3. Slack's modern 3-step external-upload flow (the old `files.upload` is deprecated/disabled):
   a. `files.getUploadURLExternal?filename=..&length=<bytes>` (GET, Bearer token) -> returns `upload_url` + `file_id`.
   b. POST the raw bytes to `upload_url` as multipart/form-data field name `file`. Success body is literally `OK - <bytes>`.
   c. `files.completeUploadExternal` (POST JSON, Bearer) with
      `{"files":[{"id":file_id,"title":"..."}],"channel_id":"<DM>","initial_comment":"..."}`.
4. Then optionally `office-say` a short text note (the initial_comment already shows under the file, so keep the note non-duplicative).

## Pitfalls
- Use `channel_id` (singular, the DM id from .reply-context), NOT `channels`. The new endpoint wants `channel_id`.
- `initial_comment` renders as the message above the file - good place for the one-line caption.
- Multipart field MUST be named `file`. Set a Content-Type for the part (e.g. the docx mime) to be safe.
- Token has files:write scope on the agent's own app; you post AS that agent (its avatar/name), same as office-say.

## Verification
- Step (a) `ok:true`, step (b) body `OK - <len>`, step (c) `ok:true`. If c returns `not_in_channel` for a public channel, the DM id is fine; DMs don't need a join.

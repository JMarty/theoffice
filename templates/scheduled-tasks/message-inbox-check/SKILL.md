---
name: message-inbox-check
description: Check for pending inter-agent messages every 3 min
---

Check for pending inter-agent messages addressed to you. Run: curl -s -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" "http://localhost:3430/api/messages?to=<agent-id>&status=pending" and process each one. For each message: read it, take the appropriate action (reply, delegate, update kanban, etc.), then mark it completed with: curl -s -X PUT http://localhost:3430/api/messages/ID -H "Content-Type: application/json" -H "Authorization: Bearer $(cat $OFFICE_TENANT_ROOT/store/.dashboard-token)" -d "{\"status\":\"completed\",\"result\":\"Processed\"}" -- If there are NO pending messages, do nothing. No Telegram message. Just finish silently.

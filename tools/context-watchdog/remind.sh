#!/bin/bash
T=$(cat /opt/claude/theoffice/tenant/store/.dashboard-token)
curl -s -X POST http://127.0.0.1:3430/api/messages -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{"from":"darryl","to":"darryl","content":"REMINDER (marveen 22825): 24h dry-run of the new gate (idle >15min, 1 compact per agent per 6h) is done: send marveen the watchdog.log summary since 2026-10-22 07:40. Keep CTX_ACT_JSONL OFF until he says yes."}' >/dev/null

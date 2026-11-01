#!/usr/bin/env python3
"""UserPromptSubmit hook (owner rule 2026-11-01): if the prompt mentions a topic
that has a skill, inject "invoke skill X first, read it in full, re-open before
each step". All fleet agents (owner 2026-11-01); silent (exit 0, no output) otherwise.
Generic routes live below. Tenant-specific routes go in $OFFICE_TENANT_ROOT/config/skill-routes.json
as [["regex", "skill-name"], ...] (never committed: that file travels in the encrypted backup)."""
import json, os, re, sys

try:
    prompt = json.load(sys.stdin).get("prompt", "") or ""
except Exception:
    sys.exit(0)
p = prompt.lower()

ROUTES = [
    (r"eg[eé]szs[eé]gpajzs|f[oő]zel[eé]k|t[ií]z[oó]rai|uzsonna|feltet|feltét", "egeszsegpajzs-meal-package"),
    (r"morning-briefing|morning briefing|reggeli", "morning-briefing-compose"),
    (r"demo request|demó|minta meg|kops-demo|demo material", "kops-demo-intake"),
    (r"crm note \w+ scope=|crm mail \w+ scope=", "crm-note"),
    (r"tidy.*crm|crm.*tidy", "kops-crm-tidy"),
    (r"\bbp\b.*doctor|vérnyomásnapló|bp log", "bp-doctor-log"),
    (r"wegovy|blood pressure|vérnyomás|weight|súly|symptom|medication|gyógyszer", "health-context-load"),
    (r"accountant package|könyvelő|auditliget", "accountant-package"),
    (r"all inboxes|check all mail|multi.?gmail", "gmail-multi-inbox-check"),
    (r"kifli.*(quantit|how many)", "kifli-order-quantities"),
    (r"fill (in )?(this|the) (pdf|form)|töltsd ki", "fill-pdf-form"),
    (r"when (should|do) i leave|indul(jak|ni)", "departure-time-from-waze"),
    (r"send (me )?(it )?as a (pdf|file)|as a file", "slack-file-send"),
    (r"profit first", "kops-profit-first"),
    (r"ügyfélportál|ugyfelportal|client portal|portal-sent|demo-intake|kezdhetitek|run the portal", "kops-portal-pipeline-run"),
    (r"cloudflare|wrangler|workers?\b.*deploy|pages deploy", "cloudflare"),
    (r"deploy (a )?static page", "deploy-static-page-cloudflare"),
    (r"finance sweep|periodic sweep|72h cross-?check", "finance-periodic-sweep"),
    (r"monthly reconciliation|month(ly)? close|bank statements?", "finance-monthly-reconciliation"),
    (r"open bills|what do i owe|unpaid invoice", "ap-email-match"),
    (r"k-?ops monthly package|havi könyvelői", "kops-monthly-accountant-package"),
    (r"flight search|find (me )?flights?|repülőjegy", "flight-search"),
    (r"flight confirmation|booking confirmation.*calendar", "flight-confirmation-to-calendar"),
    (r"airbnb", "airbnb-listing-scrape"),
    (r"meetup page", "meetup-page-polish"),
    (r"lead ?gen|leadlista|ügyfélkeresés|prospect list", "hu-sme-lead-gen"),
    (r"frozen pane|stuck on (a )?modal|usage.?limit modal", "clear-agent-modal-safely"),
    (r"restart (the )?(dashboard|service)|blast radius", "verify-restart-blast-radius"),
    (r"\bpr\b|pull request|open issues?", "github-pr-issue-review-merge"),
    (r"git pull|update the repo", "repo-update-local-patches"),
    (r"youtube\.com|youtu\.be|research this|knowledge base", "knowledge-scout"),
    (r"token usage|usage report|which agent is eating", "fleet-token-usage-breakdown"),
    (r"nav ?(számla|navision)|navision", "forch-nav-navision-skill"),
]
try:
    _tenant = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
    ROUTES += [tuple(r) for r in json.load(open(os.path.join(_tenant, "config", "skill-routes.json")))]
except Exception:
    pass
hits = []
for rx, skill in ROUTES:
    if re.search(rx, p) and skill not in hits:
        hits.append(skill)
if not hits:
    sys.exit(0)
msg = ("SKILL ROUTER (owner standing rule 2026-11-01): this message touches "
       + ", ".join(hits)
       + ". Before answering or acting: invoke the skill(s) with the Skill tool, read them IN FULL, "
       "and follow them. Re-open the relevant section before EACH step (plan, rebuild, order, payment, send). "
       "Also read the last chat on this task in the owner DM before building a recurring deliverable. "
       "Old artifacts (last week's files/scripts) are not the skill.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": msg}}))

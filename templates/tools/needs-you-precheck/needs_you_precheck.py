#!/usr/bin/env python3
"""
needs_you_precheck (v2) — first-pass evidence check for the briefing's Needs-You gate.

Given a case-number / keywords, search marveen memory for evidence an item is already handled,
so an already-done item is not surfaced to the owner as an action he owes (e.g. a certificate that
was nagged twice after it had already been sent).

v2 rewrite after adversarial QA showed v1 returned FALSE RESOLVED on every open
probe — the DANGEROUS direction (it would hide a real needs-you). Three v1 bugs fixed:
  (i)  SUBSTRING match ("order"->"ordered", "split"->"splitwise"): now WORD-BOUNDARY token match.
  (ii) anchor+marker unrelated: now they must co-occur in the SAME memory, AND only a genuinely
       identifying anchor counts.
  (iii) recurring-instance collision (old resolved permit/grocery/payroll vs a new open one): only a
       STRONG CASE NUMBER (>=4 digits) can yield a droppable RESOLVED — case numbers are unique per
       instance. A distinctive WORD match yields only REVIEW (confirm before drop), never an auto-drop.

Verdicts (exit 0 always; the skill reads the verdict):
  RESOLVED : strong case-number anchor + resolution marker co-occur -> safe for the skill to DROP.
  REVIEW   : a distinctive word + marker co-occur -> POSSIBLE; skill must CONFIRM (Gmail SENT / source)
             before dropping, else SURFACE. Never an auto-drop.
  OPEN     : no evidence -> surface.
The skill DEFAULTS TO SURFACING; it only drops on RESOLVED or on its own positive confirmation.
"""
import sys, os, re, json, urllib.request, urllib.parse, unicodedata
TENANT = os.environ.get("OFFICE_TENANT_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.environ.get("OFFICE_ROOT", os.path.dirname(TENANT))

MARKERS = {
    "sent","submitted","ordered","approved","paid","closed","resolved","delivered",
    "filed","confirmed","done","handled","elkuldve","megrendeltem","benyujtva",
    "kifizetve","lezarva","elintezve","alairva","kikuldve","beadva","kesz","megrendelve",
}
STOP = {
    "approval","approve","deadline","official","invoice","bill","payment","trip","flight",
    "booking","reply","email","letter","notice","case","the","and","for",
    "item","needs","you","before","after","data","docs","doc","document","documents",
    "field","fields","flow","attendee","attendees","form","forms","list","update","status",
    "info","extras","plus","room","new","note","notes","add","fill","with","from","this",
    "that","renewal","order","office","week","this","settle","grocery","supplies","permit",
}
# tenant-specific stop words (owner/place names etc.) live in <tenant>/config/needs-you-precheck.json {"stop_extra": [...]}
try:
    _cfg = os.path.join(os.environ.get("OFFICE_TENANT_ROOT", os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))), "config", "needs-you-precheck.json")
    STOP |= {w.lower() for w in json.load(open(_cfg)).get("stop_extra", [])}
except Exception:
    pass

def strip(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()

def tokset(s):
    return set(re.findall(r"[a-z0-9]+", strip(s)))

def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print("OPEN: no query given"); sys.exit(0)
    query = sys.argv[1].strip()
    qtokens = tokset(query)
    raw = strip(query)
    # STRONG case-number anchor — the ONLY thing that yields a droppable RESOLVED. It must be a
    # genuinely item-UNIQUE identifier, which in practice means a FORMATTED case-ref: digit groups
    # joined by / or - (e.g. 12345/6789-1). Bare standalone numbers are NOT accepted:
    #   - years (2026/2027) recur everywhere (QA), and
    #   - 5-6 digit AMOUNTS / SIM ids / valuations collide across unrelated memories (QA:
    #     a bare amount auto-dropped off an unrelated memory holding a 6-digit number + a marker).
    # A bare long number -> falls through to a distinctive-WORD match = REVIEW at most, never auto-drop.
    # From a formatted ref, accept only >=5-DIGIT groups: a 3-digit serial in the invoice shape
    # "2026/123" is NOT unique and collides across memories (QA: an UNPAID 2026/NNN invoice got
    # auto-dropped off a briefing note holding "NNN" + "paid"). A real case-ref with a 5-digit group survives;
    # a short case-ref harmlessly degrades to REVIEW (surfaced + confirmed), never an auto-drop.
    # A genuine case-ref has MULTIPLE substantial groups (12345/6789-1 = 12345 AND 6789); a slashed
    # AMOUNT like "12/345678" has one big group + a throwaway. So a formatted ref only contributes
    # strong anchors if it has >=2 groups of >=4 digits (QA); from those, take the >=5-digit
    # ones (a 4-digit serial stays non-unique -> REVIEW). Then drop any 4-digit year defensively.
    strong_nums = set()
    for f in re.findall(r"\d{2,}[/-]\d[\d/-]*", raw):
        big = [g for g in re.findall(r"\d+", f) if len(g) >= 4]
        if len(big) >= 2:
            strong_nums |= {g for g in big if len(g) >= 5}
    strong_nums = {n for n in strong_nums if not (len(n) == 4 and 1900 <= int(n) <= 2099)}
    # distinctive WORD anchors: >=6 chars, not generic
    word_anchors = {t for t in qtokens if not t.isdigit() and len(t) >= 6 and t not in STOP}
    if not strong_nums and not word_anchors:
        print("OPEN: query has no distinctive anchor (only generic words/short numbers) — verify manually")
        sys.exit(0)

    tenant = os.environ.get("OFFICE_TENANT_ROOT", TENANT)
    port = os.environ.get("OFFICE_PORT", "3430")
    try:
        token = open(os.path.join(tenant, "store", ".dashboard-token")).read().strip()
    except Exception as e:
        print(f"OPEN: cannot read token ({e}) — verify manually"); sys.exit(0)
    url = f"http://127.0.0.1:{port}/api/memories?agent=marveen&q={urllib.parse.quote(query)}&limit=20"
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        data = json.load(urllib.request.urlopen(req, timeout=10))
    except Exception as e:
        print(f"OPEN: memory query failed ({e}) — verify manually"); sys.exit(0)
    rows = data if isinstance(data, list) else data.get("memories", data.get("items", []))

    review = None
    for r in rows:
        mtoks = tokset(r.get("content", ""))
        markers_here = MARKERS & mtoks
        if not markers_here:
            continue
        # STRONG: a case number from the query appears as a token in this memory
        if strong_nums & mtoks:
            snip = (r.get("content", "")[:150]).replace("\n", " ")
            print(f"RESOLVED: case-number {sorted(strong_nums & mtoks)} + marker {sorted(markers_here)} in mem {r.get('id')}: {snip}")
            sys.exit(0)
        # WEAK: a distinctive word co-occurs with a marker -> REVIEW (not a drop)
        if word_anchors & mtoks and review is None:
            snip = (r.get("content", "")[:150]).replace("\n", " ")
            review = f"REVIEW: distinctive '{sorted(word_anchors & mtoks)}' + marker {sorted(markers_here)} in mem {r.get('id')} — CONFIRM against Gmail SENT/source before dropping, else SURFACE: {snip}"
    if review:
        print(review); sys.exit(0)
    print("OPEN: no resolution evidence tied to this item — surface it")
    sys.exit(0)

if __name__ == "__main__":
    main()

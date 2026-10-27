#!/usr/bin/env python3
"""
english_guard — send-time gate for owner-facing messages that must be English.

Reads text (stdin/arg); exit 0 if English, exit 1 + offenders if Hungarian. The point is
MECHANISM not vigilance: a flow that must stay English pipes its office-say draft through this, so a
Hungarian message literally cannot be sent.

Detection (v2, after adversarial QA found the v1 whole-word list both LEAKED agglutinated
Hungarian (a suffixed form missed because only the bare stem was listed) and FALSE-BLOCKED
English proper nouns via 2-letter markers):

  1. LONG STEMS (>=5 chars, accent-stripped) matched as a SUBSTRING of a token. A long Hungarian
     stem inside a token is a strong signal and survives agglutination: 'kifizet' is inside
     'kifizetes', 'elkuld' inside 'elkuldom'. Long stems almost never collide with English.
  2. SAFE WHOLE-WORDS (>=3 chars, exact, accent-stripped) — Hungarian function words with no English
     collision. NO 2-letter markers (that was the false-block bug).

Block if: >=1 long-stem hit, OR >=2 whole-word hits. English text that merely names a Hungarian
proper noun (Kovacs, Smith) has neither, so it passes. Deliberately narrow: it guards a recurring
slip, it is not a general language classifier.
"""
import sys, re, unicodedata

# Long Hungarian stems (accent-stripped, >=5 chars), matched as substring of a token.
LONG_STEMS = [
    "szabalytalan", "idopont", "megrendel", "elintez", "elkuld", "teendo", "kertem",
    "holnap", "tegnap", "felvezet", "hajnal", "meres", "naplo", "aludj", "figyelj",
    "rendben", "koszon", "udvozl", "csatol", "mellekel", "benyujt", "kifizet",
    "lezarva", "alairva", "megbeszel", "idopontot", "szerelo", "vizvezetek",
]
# Safe whole-words (exact, accent-stripped, >=3 chars, no English collision). No 2-letter markers.
SAFE_WHOLE = {
    "nem", "nincs", "hogy", "vagy", "semmi", "minden", "oke", "szia", "kedves",
    "vedd", "jol", "koszi", "koszonom", "kerlek", "uj", "lesz",
    "csak", "vissza", "reggeli", "esti", "magas", "alacsony",
    "szerintem", "tehat", "illetve", "valamint", "viszont", "amugy", "ugye",
}
# NOTE: 'meg','mar','volt' were REMOVED: they collide with English (name Meg,
# unit/brand Volt, verb 'mar') and two of them together false-blocked a legit English sentence.

def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")

def analyze(text):
    tokens = re.findall(r"[^\W\d_]+", text, re.UNICODE)
    norm = [strip_accents(t).lower() for t in tokens]
    stem_hits, whole_hits = [], []
    for orig, t in zip(tokens, norm):
        if any(stem in t for stem in LONG_STEMS):
            stem_hits.append(orig)
        elif t in SAFE_WHOLE:
            whole_hits.append(orig)
    return stem_hits, whole_hits

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    stem_hits, whole_hits = analyze(text)
    block = bool(stem_hits) or len(whole_hits) >= 2
    if block:
        offenders = sorted(set(stem_hits + whole_hits), key=str.lower)
        sys.stderr.write("english-guard: BLOCKED — Hungarian detected: " + ", ".join(offenders) + "\n")
        sys.stderr.write("Rewrite the message in English before sending.\n")
        sys.exit(1)
    sys.exit(0)

if __name__ == "__main__":
    main()

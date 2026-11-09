#!/usr/bin/env python3
"""Seen-ids diff for watch tasks: print only the items not reported before.

stdin: JSON - a list of objects, or an object holding the list under --list-key (e.g. rows, requests, questions).
Usage:
  curl -s ... | python3 -I seen_diff.py STATE.json feedback_seen_ids --list-key rows [--id id] [--fields a,b,c] [--commit]
Prints one JSON line per NEW item (only --fields if given) and a last line "NEW <n> / TOTAL <m>".
--commit appends the new ids to STATE[KEY] (atomic write). Run WITHOUT --commit first, report, then commit,
so a run that dies before reporting does not swallow items.
A missing STATE file or key starts empty. Bad/empty stdin exits 2 and changes nothing (an outage is not "nothing new").
"""
import json, os, sys, argparse, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('state'); ap.add_argument('key')
ap.add_argument('--list-key'); ap.add_argument('--id', default='id'); ap.add_argument('--fields'); ap.add_argument('--commit', action='store_true')
a = ap.parse_args()
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    items = data[a.list_key] if a.list_key else data
    assert isinstance(items, list)
except Exception as e:
    print(f'ERROR input is not the expected JSON list ({type(e).__name__}): {raw[:200]!r}', file=sys.stderr); sys.exit(2)
st = json.load(open(a.state)) if os.path.exists(a.state) else {}
seen = set(map(str, st.get(a.key, [])))
new = [it for it in items if str(it.get(a.id)) not in seen]
keep = a.fields.split(',') if a.fields else None
for it in new:
    print(json.dumps({k: it.get(k) for k in keep} if keep else it, ensure_ascii=False))
print(f'NEW {len(new)} / TOTAL {len(items)}')
if a.commit and new:
    st[a.key] = list(st.get(a.key, [])) + [it.get(a.id) for it in new]
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(a.state)) or '.')
    with os.fdopen(fd, 'w') as f: json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, a.state)

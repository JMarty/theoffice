#!/usr/bin/env python3
"""Context occupancy + ceiling, read from a session transcript instead of the pane footer.

WHY NOT THE FOOTER: the pane indicator is a UI string that disappears across CLI updates, which is how
context-watchdog went blind for 12 days while reporting {"ok": true} (cards 73431cd9 / 73b3797b).

WHY MAX AND NOT THE LAST RECORD -- this is the constraint occupancy_test.py exists to lock:
  `~/.claude/projects/*/*.jsonl` is NOT strictly timestamp-ordered. Measured on marveen's transcript
  2026-09-26: 834 of 18,268 records were later lines bearing earlier timestamps. Those inversions were in
  `user` (31) and `attachment` (18) records; assistant records showed 0 of 8,098, and MAX equalled LAST on
  every real file available. So `[-1]` LOOKS correct, is shorter, and passes against every observed file --
  which is exactly why the guard is a FIXTURE with manufactured inversions, not this comment (marveen,
  bus 18055; a comment never inherits a test's authority).
MAX is correct by construction: occupancy grows monotonically between compactions (verified 654 steps on
darryl's file, 125 on marveen's, zero decreases), so the high-water mark after the anchor IS the occupancy,
regardless of what order the records were written in.
"""
import json


def _metadata(d):
    """A compact_boundary's metadata, wherever it is nested. None if this record has none --
    the metadata-LESS boundaries are session restarts, not compactions, and must not anchor."""
    if isinstance(d, dict):
        if "preTokens" in d:
            return d
        for v in d.values():
            r = _metadata(v)
            if r:
                return r
    return None


def read_transcript(path):
    """-> (occupancy, ceiling, n_boundaries). occupancy/ceiling are None when unmeasurable.

    ceiling = the newest metadata-bearing preTokens. occupancy = MAX over assistant records AFTER the
    newest such boundary. Returning None is a FIRST-CLASS RESULT: callers must treat it as
    could-not-measure, never as "plenty of room".
    """
    anchor_pos, ceiling, boundaries = -1, None, []
    rows = []
    for pos, line in enumerate(open(path, encoding="utf8", errors="replace")):
        try:
            d = json.loads(line)
        except Exception:
            continue                      # counted by the caller if it cares; never silently "healthy"
        if "compact_boundary" in line:
            md = _metadata(d)
            if md:                        # metadata-less boundary => restart, not a compaction
                boundaries.append(md.get("preTokens"))
                anchor_pos, ceiling = pos, md.get("preTokens")
            continue
        if d.get("type") == "assistant":
            u = (d.get("message") or {}).get("usage") or {}
            if u:
                rows.append((pos, (u.get("cache_read_input_tokens") or 0)
                                  + (u.get("cache_creation_input_tokens") or 0)))
    after = [occ for pos, occ in rows if pos > anchor_pos]
    return (max(after) if after else None), ceiling, len(boundaries)

#!/usr/bin/env python3
"""Nightly off-box code sync (owner: 'it can't live on our server only'). For every own git repo under the engine root (plus config extra_roots):
push all local branches to origin (fast-forward or new only, NEVER force, never to other remotes), secret-scan before pushing, then write store/offsite-code.json
(checked_at, repos[], problems[]) for the morning briefing and tell marveen on the bus ONLY if something is wrong (no remote, failed/held push, unpushed commits older than 24 h).
Token: one-shot http.extraheader, never stored in a remote URL."""
import json, os, re, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("OFFICE_ROOT") or os.path.dirname(os.path.dirname(HERE))      # engine checkout: <root>/tools/offsite-sync/
TEN = os.environ.get("OFFICE_TENANT_ROOT") or f"{ROOT}/tenant"; STATUS = f"{TEN}/store/offsite-code.json"
try: CFG = json.load(open(f"{TEN}/config/offsite-sync.json"))     # {extra_roots, hold, old_history, refmap, own_remote, alert_from, alert_to}
except Exception: CFG = {}
try: sys.path.insert(0, f"{TEN}/tools"); import offsite_hooks     # optional tenant hooks: pre(problems), push_gate(repo, branches) -> (ok, message)
except Exception: offsite_hooks = None
PAT = open(f"{TEN}/secrets/github/theoffice.pat").read().strip()
import base64; HDR = "http.extraheader=Authorization: Basic " + base64.b64encode(f"x-access-token:{PAT}".encode()).decode()
ROOTS = [ROOT] + CFG.get("extra_roots", [])
SKIP = ("/node_modules", "/.venv", "/.claude/worktrees", "/.wrangler", "/.git/")
# known, deliberate exceptions (reason is shown in the status + alert until someone resolves it)
HOLD = CFG.get("hold", {})      # {repo: {"branches": [...] | "all": True, "why": ...}}: deliberate exceptions, shown in the status + alert
OLD_HISTORY = CFG.get("old_history", {})      # {repo: why}: accepted old secrets, only NEW commits are scanned
REFMAP = CFG.get("refmap", {})      # {repo: {local_branch: origin_branch}}
def git(repo, *a, hdr=False, timeout=300):
    cmd = ["git", "-C", repo] + (["-c", HDR] if hdr else []) + list(a)
    r = subprocess.run(cmd, capture_output=True, text=True, errors="ignore", timeout=timeout); return r.returncode, (r.stdout + r.stderr).strip()
def discover():
    seen = {}
    for base in ROOTS:
        for dp, dn, fn in os.walk(base):
            if any(s in dp + "/" for s in SKIP): dn[:] = []; continue
            if ".git" in dn:
                gd = os.path.join(dp, ".git"); dn[:] = [d for d in dn if d != ".git"]
                rc, common = git(dp, "rev-parse", "--git-common-dir"); common = os.path.realpath(os.path.join(dp, common)) if rc == 0 else gd
                if common not in seen or len(dp) < len(seen[common]): seen[common] = dp      # linked worktrees share one repo
            elif ".git" in fn: continue
    return sorted(seen.values())
CODE_DIRS = ["functions", "public", "src", "app", "migrations", "tools", "inbox-worker", "workers", "scripts", "site", "skills", "deploy", "wrangler.toml"]
def docs_state(r, problems):
    """Owner rule 2026-10-23: docs change with the code. A repo that has adopted the docs set (docs/ARCHITECTURE.md) is flagged when its code is newer than its docs by more than a day; a repo without the set is reported as 'missing' (status file only, no alert)."""
    if not os.path.exists(os.path.join(r, "docs", "ARCHITECTURE.md")): return "missing"
    def last(paths):
        ex = [p for p in paths if os.path.exists(os.path.join(r, p))]
        if not ex: return 0
        rc, o = git(r, "log", "-1", "--format=%ct", "--", *ex); return int(o) if rc == 0 and o.strip().isdigit() else 0
    code, docs = last(CODE_DIRS), last(["docs", "README.md", "CHANGELOG.md"])
    if code and code - docs > 86400: problems.append({"repo": r, "problem": f"code is {int((code - docs) / 3600)} h newer than the docs (docs rule: update docs with every change)"}); return "stale"
    return "current"
def own_remote(url): return bool(re.match(CFG.get("own_remote", r"https://([^@/]*@)?github\.com/"), url or ""))
def main():
    now = time.time(); repos = []; problems = []
    if offsite_hooks and hasattr(offsite_hooks, "pre"): offsite_hooks.pre(problems)
    for r in discover():
        if "/.codex/" in r or "/.claude/plugins" in r: continue
        rc, urls = git(r, "remote", "-v"); origin = next((l.split()[1] for l in urls.split("\n") if l.startswith("origin") and "(push)" in l), "")
        rc, n = git(r, "rev-list", "--all", "--count")
        if rc != 0 or n.strip() in ("", "0"):
            if rc == 0 and os.path.exists(os.path.join(r, ".git")): problems.append({"repo": r, "problem": "git repo without any commit (uncommitted code lives only here)"})
            continue
        rec = {"repo": r, "origin": re.sub(r"//[^@/]*@", "//", origin) or None, "pushed": [], "held": [], "failed": [], "unpushed": 0}
        if not origin: problems.append({"repo": r, "problem": "NO REMOTE: code exists only on this box"}); rec["unpushed"] = int(n); repos.append(rec); continue
        if not own_remote(origin): continue                                                  # a third-party checkout (plugins, mcp-gsuite): not our code
        dc = os.path.join(r, "tools", "drift-check.py")                                      # repo-owned check: reference copies vs the copies that run on this box
        if os.path.exists(dc):
            d = subprocess.run([sys.executable, dc], capture_output=True, text=True)
            if d.returncode != 0: problems.append({"repo": r, "problem": "box copies drifted from the repo: " + d.stdout.strip().replace("\n", "; ")[:300]})
        if "@" in origin.split("github.com")[0]: git(r, "remote", "set-url", "origin", re.sub(r"//[^@/]*@", "//", origin)); rec["fixed_embedded_token"] = True
        hold = HOLD.get(r, {}); rm = REFMAP.get(r, {})
        rc, rem = git(r, "ls-remote", "--heads", "origin", hdr=True); remote = {l.split()[1].replace("refs/heads/", ""): l.split()[0] for l in rem.split("\n") if "\t" in l.replace(" ", "\t")} if rc == 0 else None
        if remote is None: problems.append({"repo": r, "problem": "cannot read origin: " + rem[:120]}); rec["failed"].append("ls-remote"); repos.append(rec); continue
        git(r, "fetch", "-q", "--no-tags", "origin", hdr=True, timeout=600)      # so 'is the remote ahead of us?' can be answered from objects we really have
        todo = []
        for b in git(r, "for-each-ref", "--format=%(refname:short)", "refs/heads")[1].split("\n"):
            if not b: continue
            tgt = rm.get(b, b); tip = git(r, "rev-parse", b)[1]; rt = remote.get(tgt)
            if rt == tip: continue
            if rt and git(r, "merge-base", "--is-ancestor", tip, rt)[0] == 0: continue        # remote is ahead: nothing of ours to lose
            if rt and git(r, "merge-base", "--is-ancestor", rt, tip)[0] != 0: rec["held"].append(f"{b}: diverged from origin/{tgt}"); problems.append({"repo": r, "problem": f"branch {b} diverged from origin/{tgt}; not pushed (no force)"}); continue
            if hold.get("all") or b in hold.get("branches", []): rec["held"].append(f"{b}: {hold['why']}"); rec.setdefault("info", []).append(f"HELD {b}: {hold['why']}"); continue      # a configured hold is by design: info in the status file, not an alert
            todo.append((b, tgt))
        if todo and offsite_hooks and hasattr(offsite_hooks, "push_gate"):      # tenant gate (e.g. a PII denylist for a public repo); a failure holds the push
            ok, why = offsite_hooks.push_gate(r, [b for b, _ in todo])
            if not ok:
                rec["held"] += [f"{b}: push gate not clean" for b, _ in todo]; problems.append({"repo": r, "problem": "push gate blocked: " + why[:230]}); todo = []
        if todo:
            if r in OLD_HISTORY:      # accepted old secrets: only a secret that is NOT already on origin counts as new exposure
                pat = re.compile(r"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{15,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY")
                newlog = git(r, "log", "-p", "--no-color", *[b for b, _ in todo], "--not", "--remotes=origin")[1]; oldlog = git(r, "log", "-p", "--no-color", "--remotes=origin")[1]
                fresh = set(pat.findall(newlog)) - set(pat.findall(oldlog)); sc = type("X", (), {"returncode": 2 if fresh else 0, "stdout": f"{len(fresh)} secret(s) not yet on origin"})()
            else:
                sc = subprocess.run([sys.executable, f"{HERE}/secret-scan.py", r], capture_output=True, text=True)
            if sc.returncode != 0: rec["held"] += [f"{b}: secret scan not clean" for b, _ in todo]; problems.append({"repo": r, "problem": "secret scan NOT clean, nothing pushed: " + sc.stdout.strip()[-200:]}); todo = []
        for b, tgt in todo:
            rc, out = git(r, "push", "-q", "origin", f"refs/heads/{b}:refs/heads/{tgt}", hdr=True, timeout=600)
            if rc == 0: rec["pushed"].append(b)
            else: rec["failed"].append(b); problems.append({"repo": r, "problem": f"push of {b} failed: {out[-150:]}"})
        # unpushed commits left (any branch) and the age of the oldest
        rc, left = git(r, "rev-list", "--branches", "--not", "--remotes=origin", "--format=%ct")
        times = [int(x) for x in left.split("\n") if x.isdigit()]; rec["unpushed"] = len(times)
        if times and now - min(times) > 86400 and not (rec["held"] or rec["failed"]): problems.append({"repo": r, "problem": f"{len(times)} unpushed commits, oldest {int((now - min(times)) / 3600)} h"})
        rec["docs"] = docs_state(r, problems)
        repos.append(rec)
    st = {"checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "repos": repos, "problems": problems}
    json.dump(st, open(STATUS, "w"), ensure_ascii=False, indent=1)
    import hashlib; sig = hashlib.sha1(json.dumps(sorted(f"{p['repo']}|{p['problem']}" for p in problems)).encode()).hexdigest(); sf = f"{TEN}/store/.offsite-alert-sig"
    last = open(sf).read().strip() if os.path.exists(sf) else ""
    open(sf, "w").write(sig if problems else "")                 # a cleared set resets the memory, so the same problem coming back alerts again
    if problems and sig != last:        # the SAME problem set is not re-announced (the status file still says it every run)
        tok = open(f"{TEN}/store/.dashboard-token").read().strip()
        msg = f"OFFSITE CODE: {len(problems)} problem(s): " + " | ".join(f"{os.path.relpath(p['repo'], ROOT)}: {p['problem'][:90]}" for p in problems[:4]) + (" ..." if len(problems) > 4 else "") + " (store/offsite-code.json)"
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3430/api/messages", method="POST", data=json.dumps({"from": CFG.get("alert_from", "darryl"), "to": CFG.get("alert_to", "marveen"), "content": msg[:900]}).encode(), headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}), timeout=15).read()
    print(json.dumps({"repos": len(repos), "pushed": sum(len(r["pushed"]) for r in repos), "problems": len(problems)}))
if __name__ == "__main__": main()

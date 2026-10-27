#!/usr/bin/env python3
"""Secret scan of a repo's FULL history (all branches): token patterns + every real secret value found on this box. usage: secret-scan.py REPO_DIR  -> exit 0 clean, 2 secrets found (prints kind + file, never the value)."""
import glob, json, os, re, subprocess, sys
repo = sys.argv[1]; RANGE = sys.argv[2:]   # optional: only scan these revisions (e.g. origin/main..main) for repos whose OLD history is known and accepted
PAT = re.compile(r"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{15,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-ant-[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{40,}|GOCSPX-[A-Za-z0-9_-]{15,}|1//0[A-Za-z0-9_-]{40,}|ya29\.[A-Za-z0-9_-]{40,}|\bcfut_[A-Za-z0-9]{30,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}")
vals = {}
TEN = os.environ.get("OFFICE_TENANT_ROOT") or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tenant")
try: extra = json.load(open(f"{TEN}/config/offsite-sync.json")).get("secret_roots", [])
except Exception: extra = []
roots = [f"{TEN}/secrets", f"{TEN}/store/.dashboard-token"] + extra
files = []
for r in roots:
    if os.path.isfile(r): files.append(r)
    else:
        for dp, dn, fn in os.walk(r):
            if "/.git" in dp or "node_modules" in dp or "mcp-gsuite-src" in dp: continue
            files += [os.path.join(dp, f) for f in fn]
for f in files:
    try:
        if os.path.getsize(f) > 60000: continue
        t = open(f, errors="ignore").read()
    except Exception: continue
    for line in t.split("\n"):
      if re.match(r"\s*(account[ _]?id|zone[ _]?id|project[ _]?id|database[ _]?id)\b", line, re.I): continue   # identifiers, not credentials
      for tok in re.findall(r"[A-Za-z0-9_\-\.\/+=]{24,}", line):
        if "." in tok and not tok.startswith(("ya29", "eyJ")): continue          # URLs / domains / cert urls
        if "://" in tok or tok.startswith(("http", "/", ".")) or tok.count("/") > 2 or not (re.search(r"[0-9]", tok) and re.search(r"[A-Za-z]", tok)): continue
        vals[tok] = os.path.relpath(f, os.path.dirname(TEN))
log = subprocess.run(["git", "-C", repo, "log", "-p", "--no-color"] + (RANGE if RANGE else ["--all"]), capture_output=True, text=True, errors="ignore").stdout
bad = []
for m in PAT.finditer(log): bad.append(("pattern", m.group(0)[:6] + "…"))
for tok, src in vals.items():
    if tok in log: bad.append(("known secret value from", src))
names = subprocess.run(["git", "-C", repo, "log", "--name-only", "--pretty=format:"] + (RANGE if RANGE else ["--all"]), capture_output=True, text=True, errors="ignore").stdout.split("\n")
for n in sorted(set(names)):
    if re.search(r"(^|/)(\.dev\.vars|\.env(\.[a-z]+)?|id_rsa|[^/]*\.pem|[^/]*\.p12|[^/]*oauth[^/]*\.json|[^/]*\.token|[^/]*\.pat|credentials\.(txt|json))$", n): bad.append(("secret-like file in history", n))
print(f"{repo}: {len(log)//1024} KB history, {len(vals)} real secret values checked -> " + ("CLEAN" if not bad else "FOUND " + "; ".join(f"{a} {b}" for a, b in sorted(set(bad))[:12])))
sys.exit(2 if bad else 0)

#!/usr/bin/env python3
"""Nightly encrypted off-box DATA backup to the owner's Google Drive (owner decision 2026-10-22).
Stages consistent copies (sqlite online backup, optional D1 export), tars + gzips, encrypts with gpg AES256 (passphrase in tenant/secrets/backup/PASSPHRASE, also kept by the owner),
uploads to the Drive folder named in FOLDER (drive.file token: only files this app made), prunes to 14 daily + 8 weekly, writes store/backup.json
(checked_at, ok, last_file, size, kept[], problems[]) and tells marveen on the bus ONLY when something is wrong.  --restore-test downloads the newest archive, decrypts to a temp dir and diffs it.
No code or output ever prints the passphrase or a token."""
import base64, datetime as dt, glob, hashlib, json, os, re, secrets, shutil, sqlite3, subprocess, sys, tarfile, tempfile, time, urllib.parse, urllib.request
ROOT = "/opt/claude/theoffice/tenant"; HOME = os.path.expanduser("~"); HERE = os.path.dirname(os.path.abspath(__file__))
STATUS = f"{ROOT}/store/backup.json"; PASSFILE = f"{ROOT}/secrets/backup/PASSPHRASE"; TOKFILE = os.environ.get("BACKUP_DRIVE_TOKEN") or next(iter(sorted(glob.glob(f"{ROOT}/secrets/.gmail-creds/.oauth2.drive.*.json"))), "")
FOLDER = "Office Backups (encrypted)"; PREFIX = "office-"; SUFFIX = ".tar.gz.gpg"; KEEP_DAILY, KEEP_WEEKLY = 14, 8
app = os.environ.get("BACKUP_APP_DATA", "")      # optional: an app data dir (db + projects + media) to include; unset = skipped
D1_DB = os.environ.get("BACKUP_D1_DATABASE", "")  # optional: Cloudflare D1 database name to export; unset = skipped
D1_CONFIG = os.environ.get("BACKUP_D1_CONFIG", f"{HERE}/wrangler-prod.toml")
problems = []
def say(m): print(time.strftime("%H:%M:%S"), m, flush=True)
def bus(text):
    try:
        tok = open(f"{ROOT}/store/.dashboard-token").read().strip()
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3430/api/messages", method="POST", data=json.dumps({"from": "darryl", "to": "marveen", "content": text[:170]}).encode(), headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}), timeout=15).read()
    except Exception: pass
def passphrase():
    if not os.path.exists(PASSFILE):
        os.makedirs(os.path.dirname(PASSFILE), exist_ok=True); fd = os.open(PASSFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, (base64.urlsafe_b64encode(secrets.token_bytes(32)).decode() + "\n").encode()); os.close(fd)
    os.chmod(PASSFILE, 0o600); return PASSFILE
# ---------- Drive (drive.file token) ----------
_tok = {"t": None, "exp": 0}
def access():
    if _tok["t"] and time.time() < _tok["exp"] - 60: return _tok["t"]
    d = json.load(open(TOKFILE)); data = urllib.parse.urlencode({"client_id": d["client_id"], "client_secret": d["client_secret"], "refresh_token": d["refresh_token"], "grant_type": "refresh_token"}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request(d["token_uri"], data=data), timeout=30)); _tok.update(t=r["access_token"], exp=time.time() + int(r.get("expires_in", 3000))); return _tok["t"]
def api(method, url, body=None, headers=None, raw=False, timeout=120):
    h = {"Authorization": "Bearer " + access()}; h.update(headers or {})
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    if isinstance(body, dict) or isinstance(body, list): h["Content-Type"] = "application/json"
    resp = urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout); out = resp.read()
    return (out, resp) if raw else (json.loads(out) if out else {})
def folder_id():
    q = urllib.parse.quote(f"name = '{FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false")
    fs = api("GET", f"https://www.googleapis.com/drive/v3/files?q={q}&fields=files(id,name)")["files"]
    if fs: return fs[0]["id"]
    return api("POST", "https://www.googleapis.com/drive/v3/files?fields=id", {"name": FOLDER, "mimeType": "application/vnd.google-apps.folder"})["id"]
def list_backups(fid):
    out, tok = [], None
    while True:
        q = urllib.parse.quote(f"'{fid}' in parents and trashed = false"); u = f"https://www.googleapis.com/drive/v3/files?q={q}&fields=nextPageToken,files(id,name,size,createdTime)&pageSize=200" + (f"&pageToken={tok}" if tok else "")
        r = api("GET", u); out += [f for f in r["files"] if f["name"].startswith(PREFIX) and f["name"].endswith(SUFFIX)]; tok = r.get("nextPageToken")
        if not tok: return sorted(out, key=lambda f: f["name"])
def upload(path, name, fid):
    size = os.path.getsize(path)
    _, resp = api("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size", {"name": name, "parents": [fid]}, {"X-Upload-Content-Length": str(size)}, raw=True)
    loc = resp.headers["Location"]; CH = 32 * 1024 * 1024; off = 0
    with open(path, "rb") as f:
        while off < size:
            chunk = f.read(CH); end = off + len(chunk) - 1
            for attempt in range(5):
                try:
                    req = urllib.request.Request(loc, data=chunk, method="PUT", headers={"Content-Range": f"bytes {off}-{end}/{size}", "Content-Length": str(len(chunk))})
                    try: r = urllib.request.urlopen(req, timeout=600); body = r.read()
                    except urllib.error.HTTPError as e:
                        if e.code == 308: body = b""
                        else: raise
                    break
                except Exception:
                    if attempt == 4: raise
                    time.sleep(5 * (attempt + 1))
            off = end + 1
    return json.loads(body)["id"] if body else None
def prune(files):
    names = [f["name"] for f in files]; dates = {f["name"]: dt.datetime.strptime(f["name"][len(PREFIX):len(PREFIX) + 8], "%Y%m%d").date() for f in files}
    newest = sorted(names, reverse=True); keep = set(newest[:KEEP_DAILY]); weeks = {}
    for n in newest[KEEP_DAILY:]:
        wk = dates[n].isocalendar()[:2]
        weeks.setdefault(wk, n)      # newest archive of each older week
    for n in [weeks[w] for w in sorted(weeks, reverse=True)[:KEEP_WEEKLY]]: keep.add(n)
    gone = [f for f in files if f["name"] not in keep]
    for f in gone: api("DELETE", f"https://www.googleapis.com/drive/v3/files/{f['id']}")
    return sorted(keep), [f["name"] for f in gone]
# ---------- staging ----------
def sqlite_copy(src, dst):
    s = sqlite3.connect(f"file:{src}?mode=ro", uri=True); d = sqlite3.connect(dst); s.backup(d); d.close(); s.close()
def stage(work):
    S = os.path.join(work, "office-backup"); os.makedirs(S)
    # 1 office store DBs (live sqlite: online backup, never a raw file copy)
    os.makedirs(f"{S}/store")
    for p in sorted(glob.glob(f"{ROOT}/store/*.db")):
        try: sqlite_copy(p, f"{S}/store/{os.path.basename(p)}")
        except Exception as e: problems.append(f"sqlite {os.path.basename(p)}: {type(e).__name__}")
    for p in glob.glob(f"{ROOT}/store/*.json") + glob.glob(f"{ROOT}/store/.dashboard-token"):
        if os.path.getsize(p) < 2_000_000: shutil.copy2(p, f"{S}/store/")
    # 2 app app data (db via online backup + project files + media)
    if app:
      os.makedirs(f"{S}/app")
      try: sqlite_copy(f"{app}/app.db", f"{S}/app/app.db")
      except Exception as e: problems.append(f"app.db: {type(e).__name__}")
      for sub in ("projects", "media"):
        if os.path.isdir(f"{app}/{sub}"): shutil.copytree(f"{app}/{sub}", f"{S}/app/{sub}", symlinks=True, ignore_dangling_symlinks=True)
    # 3 scheduled tasks + tenant docs
    if os.path.isdir(f"{ROOT}/scheduled-tasks"): shutil.copytree(f"{ROOT}/scheduled-tasks", f"{S}/scheduled-tasks", symlinks=True)
    for p in glob.glob(f"{ROOT}/*.md"): shutil.copy2(p, f"{S}/")
    # 3b the office layer the engine repo does not carry: tenant config/skills/tools, user-level skills, user units, helper bin, repo list (owner 2026-10-27: GitHub = methodology, this archive = everything else)
    ign = shutil.ignore_patterns("__pycache__", "node_modules", "*.pyc", "*.log")
    for sub in ("config", "skills", "tools"):
        if os.path.isdir(f"{ROOT}/{sub}"): shutil.copytree(f"{ROOT}/{sub}", f"{S}/{sub}", symlinks=True, ignore=ign)
    for src, dst in ((f"{HOME}/.claude/skills", f"{S}/home/.claude/skills"), (f"{HOME}/.config/systemd/user", f"{S}/home/.config/systemd/user")):
        if os.path.isdir(src): shutil.copytree(src, dst, symlinks=True, ignore=ign)
    os.makedirs(f"{S}/home/.local/bin", exist_ok=True)
    for p in glob.glob(f"{HOME}/.local/bin/office-*"):
        if os.path.isfile(p): shutil.copy2(p, f"{S}/home/.local/bin/")
    repos = {}
    for dp, dn, fn in os.walk(os.path.dirname(ROOT)):
        if any(x in dp + "/" for x in ("/node_modules", "/.venv", "/.claude/worktrees", "/.wrangler", "/.git/")): dn[:] = []; continue
        if ".git" in dn:
            dn[:] = [d for d in dn if d != ".git"]
            r = subprocess.run(["git", "-C", dp, "remote", "get-url", "origin"], capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip(): repos[os.path.relpath(dp, os.path.dirname(ROOT))] = re.sub(r"//[^@/]*@", "//", r.stdout.strip())
    json.dump(repos, open(f"{S}/repos.json", "w"), indent=1, sort_keys=True)
    # 4 agents: top-level small files + memory / skills / handoff dirs
    for a in sorted(glob.glob(f"{ROOT}/agents/*/")):
        n = os.path.basename(a.rstrip("/")); dst = f"{S}/agents/{n}"; os.makedirs(dst, exist_ok=True)
        for f in os.listdir(a):
            p = os.path.join(a, f)
            if os.path.isfile(p) and os.path.getsize(p) < 2_000_000 and not f.endswith((".log", ".pyc", ".sock")): shutil.copy2(p, dst)
            elif os.path.isdir(p) and f in ("memory", "skills", "handoff", ".claude"): shutil.copytree(p, f"{dst}/{f}", symlinks=True, ignore=shutil.ignore_patterns("*.log", "node_modules", "__pycache__", "worktrees"))
    # 5 ~/.claude project memory dirs
    for m in glob.glob(f"{HOME}/.claude/projects/*/memory"):
        shutil.copytree(m, f"{S}/claude-projects/{os.path.basename(os.path.dirname(m))}/memory", symlinks=True)
    # 6 secrets (only ever inside the encrypted archive; the backup passphrase itself is NOT included)
    shutil.copytree(f"{ROOT}/secrets", f"{S}/secrets", symlinks=True, ignore=shutil.ignore_patterns("backup"))
    # 7 optional D1 export (prod)
    if D1_DB:
      os.makedirs(f"{S}/crm"); r = subprocess.run(["npx", "--yes", "wrangler", "d1", "export", D1_DB, "--remote", "--config", D1_CONFIG, "--output", f"{S}/crm/{D1_DB}.sql"], capture_output=True, text=True, timeout=600, cwd=HERE)
      if r.returncode != 0 or not os.path.exists(f"{S}/crm/{D1_DB}.sql") or os.path.getsize(f"{S}/crm/{D1_DB}.sql") < 1000: problems.append("d1 export failed")
    return S
def fhash(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
def manifest(S):
    h = hashlib.sha256(); n = 0
    lines = []
    for dp, dn, fn in os.walk(S):
        dn.sort()
        for f in sorted(fn):
            p = os.path.join(dp, f)
            if os.path.islink(p): continue
            d = fhash(p); lines.append(f"{d}  {os.path.relpath(p, S)}"); n += 1
    open(os.path.join(S, "MANIFEST.sha256"), "w").write("\n".join(lines) + "\n")
    json.dump({"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "paths": sorted(l.split("  ", 1)[1] for l in lines)}, open(f"{ROOT}/store/backup-files.json", "w"))      # names only: the drift check asks "is this local file in the archive?"
    return n
def encrypt(src, dst):
    r = subprocess.run(["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--symmetric", "--cipher-algo", "AES256", "--passphrase-file", passphrase(), "-o", dst, src], capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError("gpg failed: " + r.stderr[-120:])
def write_status(ok, **kw):
    st = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "ok": ok, "problems": problems, **kw}
    json.dump(st, open(STATUS + ".tmp", "w"), indent=1); os.replace(STATUS + ".tmp", STATUS)
def run():
    t0 = time.time(); work = tempfile.mkdtemp(prefix="office-bak-", dir=os.environ.get("BACKUP_TMP", "/var/tmp"))
    try:
        S = stage(work); n = manifest(S); say(f"staged {n} files")
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M"); tgz = f"{work}/office.tar.gz"
        with tarfile.open(tgz, "w:gz", compresslevel=6) as t: t.add(S, arcname="office-backup")
        shutil.rmtree(S); enc = f"{work}/{PREFIX}{stamp}{SUFFIX}"; encrypt(tgz, enc); os.remove(tgz); size = os.path.getsize(enc); say(f"encrypted {size // 1048576} MB")
        fid = folder_id(); up = upload(enc, os.path.basename(enc), fid)
        files = list_backups(fid); mine = [f for f in files if f["name"] == os.path.basename(enc)]
        if not mine or int(mine[0].get("size", 0)) != size: problems.append("upload size mismatch / not listed")
        keep, gone = prune(files)
        ok = not problems; write_status(ok, last_file=os.path.basename(enc), size_mb=size // 1048576, seconds=int(time.time() - t0), kept=keep, pruned=gone, files=n)
        if not ok: bus("BACKUP problem: " + "; ".join(problems)[:140])
        say("done " + ("ok" if ok else "WITH PROBLEMS"))
    except Exception as e:
        problems.append(f"{type(e).__name__}: {str(e)[:100]}"); write_status(False); bus("BACKUP FAILED: " + problems[-1]); say("FAILED " + problems[-1]); raise
    finally: shutil.rmtree(work, ignore_errors=True)
def restore_test():
    fid = folder_id(); files = list_backups(fid)
    if not files: print("no backups"); return 1
    f = files[-1]; work = tempfile.mkdtemp(prefix="office-restore-", dir=os.environ.get("BACKUP_TMP", "/var/tmp"))
    try:
        enc = f"{work}/a.gpg"; req = urllib.request.Request(f"https://www.googleapis.com/drive/v3/files/{f['id']}?alt=media", headers={"Authorization": "Bearer " + access()})
        with urllib.request.urlopen(req, timeout=900) as r, open(enc, "wb") as o: shutil.copyfileobj(r, o, 1 << 20)
        tgz = f"{work}/a.tar.gz"; r = subprocess.run(["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--decrypt", "--passphrase-file", PASSFILE, "-o", tgz, enc], capture_output=True, text=True)
        if r.returncode != 0: print("DECRYPT FAILED"); return 2
        with tarfile.open(tgz) as t: t.extractall(work, filter="tar")
        base = f"{work}/office-backup"; bad = 0; n = 0
        for line in open(f"{base}/MANIFEST.sha256"):
            if not line.strip(): continue
            d, rel = line.rstrip("\n").split("  ", 1); p = os.path.join(base, rel); n += 1
            if d != "big" and (not os.path.exists(p) or fhash(p) != d): bad += 1
        # live check: the app db copy opens and a store db is readable
        probe = f"{base}/app/app.db" if os.path.exists(f"{base}/app/app.db") else (sorted(glob.glob(f"{base}/store/*.db")) or [""])[0]
        c = sqlite3.connect(probe); tabs = c.execute("select count(*) from sqlite_master").fetchone()[0]; c.close()
        print(f"restore test of {f['name']}: {n} files, {bad} mismatched, app.db tables {tabs}"); return 0 if bad == 0 and tabs > 0 else 3
    finally: shutil.rmtree(work, ignore_errors=True)
if __name__ == "__main__":
    if "--restore-test" in sys.argv: sys.exit(restore_test())
    run()

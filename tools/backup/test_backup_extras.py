"""backup_drive.stage(): the configured private block is staged: db by online backup, files/audio/tx under the cap, a problem raised over it. python3 -m unittest test_backup_extras"""
import importlib.util, json, os, shutil, sqlite3, tempfile, unittest

CFG = {"private_block": {"dir": "store/private-data", "db": "private.db"}, "board_folder": "board-data", "mirrors": ["mirror-one", "mirror-two", "mirror-three"]}

def write_cfg(tenant):
    os.makedirs(os.path.join(tenant, "config"), exist_ok=True); json.dump(CFG, open(os.path.join(tenant, "config", "backup-extras.json"), "w"))

def load(tenant, home):
    os.environ["OFFICE_TENANT_ROOT"] = tenant; os.environ["HOME"] = home
    spec = importlib.util.spec_from_file_location("backup_drive_t", os.path.join(os.path.dirname(os.path.abspath(__file__)), "backup_drive.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="bk-"); self.tenant = os.path.join(self.d, "tenant"); self.home = os.path.join(self.d, "home")
        for p in ("store/private-data/files", "store/private-data/audio", "store/private-data/tx", "agents", "secrets/backup"): os.makedirs(os.path.join(self.tenant, p))
        os.makedirs(self.home)
        write_cfg(self.tenant)
        db = sqlite3.connect(os.path.join(self.tenant, "store/private-data/private.db")); db.execute("create table answers(id integer, text text)"); db.execute("insert into answers values (1,'PRIVATE-CANARY')"); db.commit(); db.close()
        for sub, name in (("files", "a.txt"), ("audio", "b.wav"), ("tx", "1.json")): open(os.path.join(self.tenant, "store/private-data", sub, name), "w").write("x" * 10)
        self.m = load(self.tenant, self.home)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def stage(self):
        w = os.path.join(self.d, "work"); os.makedirs(w); self.m.problems.clear(); self.m.stage(w); return os.path.join(w, "office-backup")

    def test_db_files_audio_and_transcripts_are_staged_and_the_db_is_readable(self):
        S = self.stage(); ed = os.path.join(S, "store/private-data")
        c = sqlite3.connect(os.path.join(ed, "private.db")); self.assertEqual(c.execute("select text from answers").fetchone()[0], "PRIVATE-CANARY"); c.close()
        for sub, name in (("files", "a.txt"), ("audio", "b.wav"), ("tx", "1.json")): self.assertTrue(os.path.exists(os.path.join(ed, sub, name)), sub)
        self.assertEqual([p for p in self.m.problems if "private" in p], [])

    def test_over_the_cap_the_db_is_still_saved_and_a_problem_is_raised(self):
        open(os.path.join(self.tenant, "store/private-data/audio/big.wav"), "wb").write(b"\\0" * 1000)
        orig = os.path.getsize
        import unittest.mock as mock
        with mock.patch("os.path.getsize", lambda p: 400_000_000 if str(p).endswith("big.wav") else orig(p)):
            S = self.stage()
        self.assertTrue(os.path.exists(os.path.join(S, "store/private-data/private.db")))
        self.assertFalse(os.path.exists(os.path.join(S, "store/private-data/audio")))
        self.assertTrue(any("over the 300 MB" in p for p in self.m.problems))

    def test_no_private_data_is_simply_skipped(self):
        shutil.rmtree(os.path.join(self.tenant, "store/private-data")); S = self.stage()
        self.assertFalse(os.path.exists(os.path.join(S, "store/private-data"))); self.assertEqual([p for p in self.m.problems if "private" in p], [])

class D1(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="bk-d1-"); self.tenant = os.path.join(self.d, "tenant"); self.home = os.path.join(self.d, "home")
        for p in ("store", "agents", "secrets/backup"): os.makedirs(os.path.join(self.tenant, p))
        os.makedirs(self.home)
        write_cfg(self.tenant)
        self.tok = os.path.join(self.d, "k.token"); open(self.tok, "w").write("KOPS-TOKEN-VALUE\n")
        os.environ.update(BACKUP_D1_DATABASE="kops-poll", BACKUP_D1_CONFIG="/x/kops-root/wrangler.toml", BACKUP_D1_TOKEN_FILE=self.tok, BACKUP_D1_ACCOUNT_ID="a" * 32)
        self.m = load(self.tenant, self.home)

    def tearDown(self):
        for k in ("BACKUP_D1_DATABASE", "BACKUP_D1_CONFIG", "BACKUP_D1_TOKEN_FILE", "BACKUP_D1_ACCOUNT_ID"): os.environ.pop(k, None)
        shutil.rmtree(self.d, ignore_errors=True)

    def test_the_d1_export_uses_the_configured_token_account_and_config_not_the_ambient_ones(self):
        import unittest.mock as mock
        seen = {}
        def fake(cmd, **kw):
            seen["cmd"] = cmd; seen["env"] = kw.get("env") or {}
            out = cmd[cmd.index("--output") + 1]; os.makedirs(os.path.dirname(out), exist_ok=True); open(out, "w").write("x" * 2000)
            return mock.Mock(returncode=0, stderr="")
        os.environ["CLOUDFLARE_API_TOKEN"] = "AMBIENT-MAIN-TOKEN"
        w = os.path.join(self.d, "work"); os.makedirs(w); self.m.problems.clear()
        with mock.patch.object(self.m.subprocess, "run", fake): self.m.stage(w)
        self.assertEqual(seen["env"].get("CLOUDFLARE_API_TOKEN"), "KOPS-TOKEN-VALUE"); self.assertEqual(seen["env"].get("CLOUDFLARE_ACCOUNT_ID"), "a" * 32)
        self.assertIn("/x/kops-root/wrangler.toml", seen["cmd"]); self.assertEqual([p for p in self.m.problems if "d1" in p], [])
        self.assertNotIn("KOPS-TOKEN-VALUE", " ".join(seen["cmd"]), "the token never appears on a command line")

    def test_a_missing_token_file_skips_only_the_d1_export_and_never_falls_back_to_the_ambient_token(self):
        import unittest.mock as mock
        os.environ["BACKUP_D1_TOKEN_FILE"] = os.path.join(self.d, "nope.token"); m = load(self.tenant, self.home); ran = []
        w = os.path.join(self.d, "w3"); os.makedirs(w); m.problems.clear()
        with mock.patch.object(m.subprocess, "run", lambda *a, **k: ran.append(a) or mock.Mock(returncode=0, stderr="")):
            S = m.stage(w)
        self.assertTrue(os.path.isdir(S), "the rest of the archive is still staged")
        self.assertEqual(ran, [], "wrangler never runs with the wrong (ambient) token")
        self.assertTrue(any("d1" in p for p in m.problems))

    def test_without_the_settings_the_ambient_environment_is_used_as_before(self):
        import unittest.mock as mock
        for k in ("BACKUP_D1_TOKEN_FILE", "BACKUP_D1_ACCOUNT_ID"): os.environ.pop(k, None)
        m = load(self.tenant, self.home); seen = {}
        def fake(cmd, **kw):
            seen["env"] = kw.get("env"); out = cmd[cmd.index("--output") + 1]; os.makedirs(os.path.dirname(out), exist_ok=True); open(out, "w").write("x" * 2000); return mock.Mock(returncode=0, stderr="")
        os.environ["CLOUDFLARE_API_TOKEN"] = "AMBIENT"; w = os.path.join(self.d, "w2"); os.makedirs(w)
        with mock.patch.object(m.subprocess, "run", fake): m.stage(w)
        self.assertEqual((seen["env"] or os.environ).get("CLOUDFLARE_API_TOKEN"), "AMBIENT")

class Work(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="bk-w-"); self.tenant = os.path.join(self.d, "tenant"); self.home = os.path.join(self.d, "home")
        for p in ("store", "secrets/backup", "config"): os.makedirs(os.path.join(self.tenant, p))
        os.makedirs(self.home)
        write_cfg(self.tenant)
        def w(rel, data="x"):
            p = os.path.join(self.tenant, "agents", rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(data)
        w("darryl/work/plans/PLAN.md"); w("darryl/work/plans/tool.py"); w("darryl/work/plans/page.html"); w("darryl/work/plans/data.csv"); w("darryl/work/plans/notes.txt"); w("darryl/work/plans/cfg.json")
        w("darryl/work/plans/shot.png"); w("darryl/work/plans/demo.mp4"); w("darryl/work/plans/x.db"); w("darryl/work/plans/node_modules/pkg/README.md"); w("darryl/work/plans/.venv/lib/a.py"); w("darryl/work/plans/src-ref/copy.md")
        w("darryl/work/gitrepo/.git/HEAD"); w("darryl/work/gitrepo/README.md")
        w("marveen/work/spec.md"); w("jim/work/n.md")
        w("marveen/work/board-data/board.csv"); w("marveen/work/board-data/sub/receipt.png"); w("marveen/work/board-data/big.xlsx")
        self.m = load(self.tenant, self.home)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def stage(self):
        w = os.path.join(self.d, "work"); os.makedirs(w); self.m.problems.clear(); self.m.stage(w); return os.path.join(w, "office-backup")

    def test_small_text_assets_of_every_agents_work_folder_are_staged(self):
        S = self.stage(); base = os.path.join(S, "agents-work")
        for rel in ("darryl/plans/PLAN.md", "darryl/plans/tool.py", "darryl/plans/page.html", "darryl/plans/data.csv", "darryl/plans/notes.txt", "darryl/plans/cfg.json", "marveen/spec.md", "jim/n.md"):
            self.assertTrue(os.path.exists(os.path.join(base, rel)), rel)

    def test_screenshots_video_db_dependency_dirs_and_git_repos_are_skipped(self):
        S = self.stage(); base = os.path.join(S, "agents-work")
        for rel in ("darryl/plans/shot.png", "darryl/plans/demo.mp4", "darryl/plans/x.db", "darryl/plans/node_modules", "darryl/plans/.venv", "darryl/plans/src-ref", "darryl/gitrepo"):
            self.assertFalse(os.path.exists(os.path.join(base, rel)), rel)

    def test_meetup_costs_is_staged_fully_including_binaries(self):
        S = self.stage(); base = os.path.join(S, "agents-work", "marveen", "board-data")
        for rel in ("board.csv", "sub/receipt.png", "big.xlsx"): self.assertTrue(os.path.exists(os.path.join(base, rel)), rel)

    def test_the_three_refetchable_raw_mirrors_are_left_out_and_the_other_raw_snapshots_kept(self):
        for rel in ("raw/mirror-one/files/a.pdf", "raw/mirror-one/inventory.csv", "raw/mirror-two/files/m.eml", "raw/mirror-two/cards/cards3.csv", "raw/mirror-two/index.csv", "raw/mirror-three/files/r.pdf", "raw/mirror-three/reports.csv", "raw/pam-2026-11-10/snap.json", "raw/perk-api/p.json"):
            p = os.path.join(self.tenant, "agents", "marveen/work/board-data", rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write("x")
        S = self.stage(); base = os.path.join(S, "agents-work", "marveen", "board-data", "raw")
        for rel in ("mirror-one", "mirror-two", "mirror-three"): self.assertFalse(os.path.exists(os.path.join(base, rel, "files")), rel)
        for rel in ("mirror-one/inventory.csv", "mirror-two/cards/cards3.csv", "mirror-two/index.csv", "mirror-three/reports.csv", "pam-2026-11-10/snap.json", "perk-api/p.json"): self.assertTrue(os.path.exists(os.path.join(base, rel)), rel)
        self.assertFalse([x for x in self.m.problems if "board-data" in x])

    def test_the_cap_counts_only_what_is_saved_and_is_200_mb(self):
        import unittest.mock as mock
        p = os.path.join(self.tenant, "agents", "marveen/work/board-data/raw/mirror-two/files/huge.eml"); os.makedirs(os.path.dirname(p)); open(p, "w").write("x")
        orig = os.path.getsize
        with mock.patch("os.path.getsize", lambda q: 900_000_000 if str(q).endswith("huge.eml") else 150_000_000 if str(q).endswith("big.xlsx") else orig(q)):
            self.stage()
        self.assertFalse([x for x in self.m.problems if "board-data" in x])
        w = os.path.join(self.d, "work2"); os.makedirs(w); self.m.problems.clear()
        with mock.patch("os.path.getsize", lambda q: 250_000_000 if str(q).endswith("big.xlsx") else orig(q)):
            self.m.stage(w)
        self.assertTrue(any("board-data" in x for x in self.m.problems))

    def test_an_oversized_meetup_costs_raises_a_problem_instead_of_filling_the_archive(self):
        import unittest.mock as mock
        orig = os.path.getsize
        with mock.patch("os.path.getsize", lambda p: 200_000_000 if str(p).endswith("big.xlsx") else orig(p)):
            S = self.stage()
        self.assertTrue(any("board-data" in p for p in self.m.problems))

class Bundle(unittest.TestCase):
    """work repos that have no remote (nothing pushed anywhere, e.g. the board with its cost data) are saved as a git bundle + their uncommitted text files"""
    def setUp(self):
        import subprocess
        self.d = tempfile.mkdtemp(prefix="bk-b-"); self.tenant = os.path.join(self.d, "tenant"); self.home = os.path.join(self.d, "home")
        for p in ("store", "secrets/backup"): os.makedirs(os.path.join(self.tenant, p))
        os.makedirs(self.home)
        write_cfg(self.tenant)
        def git(repo, *a): subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, *a], check=True, capture_output=True)
        def mk(rel, remote=False):
            r = os.path.join(self.tenant, "agents", rel); os.makedirs(r); git(r, "init", "-q", "-b", "main"); open(os.path.join(r, "a.txt"), "w").write("one"); git(r, "add", "."); git(r, "commit", "-qm", "first")
            if remote: git(r, "remote", "add", "origin", "https://example.invalid/x.git")
            return r
        self.board = mk("darryl/work/board"); self.pushed = mk("darryl/work/pushed", remote=True)
        open(os.path.join(self.board, "wip.py"), "w").write("print(1)"); open(os.path.join(self.board, "a.txt"), "w").write("two")
        os.makedirs(os.path.join(self.board, "dist2")); open(os.path.join(self.board, "dist2", "index.html"), "w").write("<p>built</p>"); open(os.path.join(self.board, ".gitignore"), "w").write("dist2/\n")
        open(os.path.join(self.board, "shot.png"), "w").write("png")
        self.m = load(self.tenant, self.home); self.git = git

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def stage(self):
        w = os.path.join(self.d, "work"); os.makedirs(w); self.m.problems.clear(); self.m.stage(w); return os.path.join(w, "office-backup")

    def test_a_repo_without_a_remote_is_saved_as_a_verifiable_bundle_with_its_history(self):
        import subprocess
        S = self.stage(); b = os.path.join(S, "git-bundles", "darryl", "board.bundle")
        self.assertTrue(os.path.exists(b))
        self.assertEqual(subprocess.run(["git", "bundle", "verify", b], capture_output=True).returncode, 0)
        out = os.path.join(self.d, "clone"); subprocess.run(["git", "clone", "-q", b, out], check=True, capture_output=True)
        self.assertEqual(open(os.path.join(out, "a.txt")).read(), "one")

    def test_uncommitted_and_untracked_text_files_are_saved_next_to_the_bundle_but_not_ignored_or_binary_ones(self):
        S = self.stage(); base = os.path.join(S, "git-bundles", "darryl", "board.wip")
        self.assertEqual(open(os.path.join(base, "wip.py")).read(), "print(1)")
        self.assertEqual(open(os.path.join(base, "a.txt")).read(), "two")
        self.assertFalse(os.path.exists(os.path.join(base, "dist2")))
        self.assertFalse(os.path.exists(os.path.join(base, "shot.png")))

    def test_a_repo_that_has_a_remote_is_not_bundled(self):
        S = self.stage(); self.assertFalse(os.path.exists(os.path.join(S, "git-bundles", "darryl", "pushed.bundle")))

    def test_a_failing_bundle_raises_a_problem_and_the_rest_of_the_backup_goes_on(self):
        import unittest.mock as mock
        real = __import__("subprocess").run
        def boom(cmd, *a, **k):
            if "bundle" in cmd and "create" in cmd: raise OSError("no git")
            return real(cmd, *a, **k)
        with mock.patch.object(self.m.subprocess, "run", boom):
            S = self.stage()
        self.assertTrue(any("board" in p and "bundle" in p for p in self.m.problems))
        self.assertTrue(os.path.isdir(os.path.join(S, "store")))

if __name__ == "__main__":
    unittest.main()

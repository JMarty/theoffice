import json
import os
import subprocess
import tempfile
import unittest

import install_hook as ih

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "freeze-hook.sh")


def run(path):
    return subprocess.run(["sh", HOOK, path], capture_output=True, text=True, input='{"tool_name":"Bash"}')


class Hook(unittest.TestCase):
    def test_no_file_means_every_tool_call_passes_silently(self):
        r = run(os.path.join(tempfile.mkdtemp(), "fleet-freeze.json"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_file_present_rejects_with_exit_2_and_a_message_for_the_agent(self):
        f = os.path.join(tempfile.mkdtemp(), "fleet-freeze.json")
        open(f, "w").write("{}")
        r = run(f)
        self.assertEqual(r.returncode, 2)
        self.assertIn("FLEET FROZEN", r.stderr)
        self.assertIn("do not try to remove", r.stderr)

    def test_an_unreadable_file_still_freezes(self):
        f = os.path.join(tempfile.mkdtemp(), "fleet-freeze.json")
        open(f, "w").write("{}")
        os.chmod(f, 0)
        try:
            self.assertEqual(run(f).returncode, 2)
        finally:
            os.chmod(f, 0o600)

    def test_no_argument_fails_open_rather_than_freezing_everything_by_mistake(self):
        self.assertEqual(subprocess.run(["sh", HOOK], capture_output=True).returncode, 0)


class Install(unittest.TestCase):
    def test_installs_first_idempotently_keeps_other_hooks_and_removes_cleanly(self):
        other = {"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 /x/email-send-gate/email_gate.py hook"}]}
        cur = {"model": "m", "hooks": {"PreToolUse": [other], "Stop": [{"hooks": []}]}}
        once = ih.apply(cur, "/e", "/t")
        self.assertEqual(once, ih.apply(once, "/e", "/t"))
        pre = once["hooks"]["PreToolUse"]
        self.assertEqual(pre[0]["matcher"], "*")           # the freeze runs before every other hook
        self.assertEqual(pre[1], other)
        self.assertIn("/e/tools/fleet-freeze/freeze-hook.sh /t/store/fleet-freeze.json", pre[0]["hooks"][0]["command"])
        self.assertEqual(once["model"], "m")
        self.assertEqual(ih.apply(once, "/e", "/t", remove=True), cur)


if __name__ == "__main__":
    unittest.main()

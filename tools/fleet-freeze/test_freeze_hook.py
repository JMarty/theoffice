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



class DetectorsStayQuietWhileFrozen(unittest.TestCase):
    """The delivery detectors must not alarm about the silence a freeze causes on purpose."""

    def setUp(self):
        self.t = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.t, "store"))
        open(os.path.join(self.t, "store", "fleet-freeze.json"), "w").write("{}")
        self.tools = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def _import(self, rel, name):
        import importlib.util
        spec = importlib.util.spec_from_file_location(name, os.path.join(self.tools, rel))
        mod = importlib.util.module_from_spec(spec)
        os.environ["OFFICE_TENANT_ROOT"] = self.t
        spec.loader.exec_module(mod)
        return mod

    def test_owner_watchdog_does_nothing_and_never_opens_the_db(self):
        m = self._import("owner-watchdog/owner_watchdog.py", "ow")
        self.assertEqual(m.run_once(), {"alert": [], "redrive": []})  # no DB exists in the temp tenant: reaching it would raise

    def test_owner_ack_guard_does_nothing_and_never_opens_the_db(self):
        m = self._import("owner-ack-guard/owner_ack_guard.py", "oag")
        self.assertEqual(m.run_once(), [])

    def test_frozen_pane_alarm_exits_0_silently_before_touching_anything(self):
        r = subprocess.run(["bash", os.path.join(self.tools, "frozen-pane-alarm", "frozen-pane-alarm.sh")], env={"OFFICE_TENANT_ROOT": self.t, "PATH": os.environ["PATH"]}, capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertFalse(os.path.exists(os.path.join(self.t, "store", "frozen-pane-alarm.log")))


if __name__ == "__main__":
    unittest.main()

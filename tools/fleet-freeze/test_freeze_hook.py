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



class FrozenButOwnerComms(unittest.TestCase):
    """A freeze stops agent WORK, never the agent's voice to the owner: a plain office-say call still goes through, nothing else does."""

    def run_hook(self, tool, tool_input):
        f = os.path.join(tempfile.mkdtemp(), "fleet-freeze.json")
        open(f, "w").write("{}")
        return subprocess.run(["sh", HOOK, f], capture_output=True, text=True, input=json.dumps({"tool_name": tool, "tool_input": tool_input}))

    def bash(self, cmd):
        return self.run_hook("Bash", {"command": cmd}).returncode

    def test_plain_office_say_forms_are_allowed_while_frozen(self):
        for c in ['office-say "Fleet is frozen, waiting for you"', "office-say 'status: all quiet'", "office-say <<'EOF'\nline one\n`literal` $(not run) \"q\"\nEOF", "office-say  \"two spaces\"  "]:
            self.assertEqual(self.bash(c), 0, c)

    def test_anything_that_could_do_more_than_speak_is_still_denied(self):
        bad = ['office-say "x"; rm -rf /tmp/x', 'office-say "x" && ls', 'office-say "x" | tee /tmp/f', 'office-say "$(cat /etc/passwd)"', 'office-say "`id`"', 'office-say $HOME', "office-say \"x\" > /tmp/f",
               "office-say <<EOF\n$(id)\nEOF", "office-say <<'EOF'\nhi\nEOF\nrm -rf /tmp/x", "office-say <<'EOF'\nhi\nEOF; ls", "ls", "cat /etc/passwd", "echo office-say", "curl -s http://127.0.0.1:3430/api/fleet/freeze",
               "office-say", "office-say --help", 'office-say "a" "b"', "env office-say 'x'", "/bin/sh -c 'office-say x'"]
        for c in bad:
            self.assertEqual(self.bash(c), 2, c)

    def test_other_tools_are_denied_even_with_an_office_say_looking_input(self):
        for tool in ("Read", "Edit", "Write", "WebFetch", "mcp__claude_ai_Gmail__send_message"):
            self.assertEqual(self.run_hook(tool, {"command": 'office-say "x"'}).returncode, 2, tool)

    def test_garbled_input_while_frozen_is_denied(self):
        f = os.path.join(tempfile.mkdtemp(), "fleet-freeze.json")
        open(f, "w").write("{}")
        self.assertEqual(subprocess.run(["sh", HOOK, f], capture_output=True, text=True, input="not json").returncode, 2)

    def test_thawed_everything_still_passes(self):
        f = os.path.join(tempfile.mkdtemp(), "nofile.json")
        self.assertEqual(subprocess.run(["sh", HOOK, f], capture_output=True, text=True, input='{"tool_name":"Bash","tool_input":{"command":"rm -rf x"}}').returncode, 0)


if __name__ == "__main__":
    unittest.main()

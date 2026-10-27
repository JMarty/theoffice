"""Red-first tests for the agent-state trial: hook events -> state, compared against sampled pane state."""
import json
import os
import subprocess
import tempfile
import unittest

import agent_state as st

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-state-hook.sh")
S = 1000  # ms per second


def ev(t, e, extra=""):
    return {"ts": t * S, "event": e, "extra": extra}


class Derive(unittest.TestCase):
    def test_event_sequence_gives_the_expected_states(self):
        events = [ev(0, "SessionStart"), ev(10, "UserPromptSubmit"), ev(11, "PreToolUse", "Bash"), ev(12, "PostToolUse", "Bash"),
                  ev(20, "Notification", "perm"), ev(30, "PostToolUse", "Bash"), ev(40, "Stop"), ev(50, "SessionEnd")]
        tl = st.timeline(events)
        self.assertEqual([(s["from_ms"] // S, s["state"]) for s in tl],
                         [(0, "idle"), (10, "working"), (20, "awaiting_approval"), (30, "working"), (40, "idle"), (50, "ended")])

    def test_state_at_a_time(self):
        tl = st.timeline([ev(0, "SessionStart"), ev(10, "UserPromptSubmit"), ev(40, "Stop")])
        self.assertEqual(st.state_at(tl, 5 * S), "idle")
        self.assertEqual(st.state_at(tl, 25 * S), "working")
        self.assertEqual(st.state_at(tl, 40 * S), "idle")
        self.assertIsNone(st.state_at(tl, -1))  # before anything was observed

    def test_an_idle_notification_is_not_an_approval_wait(self):
        tl = st.timeline([ev(0, "SessionStart"), ev(5, "Notification", "idle")])
        self.assertEqual(st.state_at(tl, 6 * S), "idle")

    def test_consecutive_same_states_collapse(self):
        tl = st.timeline([ev(0, "UserPromptSubmit"), ev(1, "PreToolUse"), ev(2, "PostToolUse")])
        self.assertEqual(len(tl), 1)

    def test_show_reports_state_since_and_a_bounded_history(self):
        events = [ev(i, "UserPromptSubmit" if i % 2 == 0 else "Stop") for i in range(300)]
        s = st.show(events, now_ms=400 * S)
        self.assertEqual(s["state"], "idle")
        self.assertLessEqual(len(s["history"]), 50)
        self.assertEqual(s["updated_at"], 299 * S)


class Compare(unittest.TestCase):
    def setUp(self):
        # working 10..40, idle otherwise
        self.tl = st.timeline([ev(0, "SessionStart"), ev(10, "UserPromptSubmit"), ev(40, "Stop")])

    def sample(self, t, p):
        return {"ts": t * S, "state": p}

    def test_agreement_counts_matches_and_names_mismatches(self):
        samples = [self.sample(5, "idle"), self.sample(20, "busy"), self.sample(30, "busy"), self.sample(60, "idle"), self.sample(25, "idle")]
        r = st.compare(self.tl, samples, tolerance_ms=3 * S)
        self.assertEqual(r["compared"], 5)
        self.assertEqual(r["agree"], 4)
        self.assertEqual(r["disagree"], [{"hook": "working", "pane": "idle", "n": 1}])
        self.assertAlmostEqual(r["agreement"], 0.8)

    def test_samples_near_a_transition_are_ignored_not_counted(self):
        r = st.compare(self.tl, [self.sample(11, "idle"), self.sample(39, "idle"), self.sample(20, "busy")], tolerance_ms=3 * S)
        self.assertEqual((r["compared"], r["skipped_near_transition"]), (1, 2))

    def test_unknown_pane_samples_are_reported_separately_not_as_disagreement(self):
        r = st.compare(self.tl, [self.sample(20, "unknown"), self.sample(20, "busy")], tolerance_ms=3 * S)
        self.assertEqual((r["compared"], r["agree"], r["pane_unknown"]), (1, 1, 1))

    def test_typing_counts_as_idle_and_an_approval_wait_matches_a_modal_pane(self):
        tl = st.timeline([ev(0, "SessionStart"), ev(10, "Notification", "perm")])
        r = st.compare(tl, [self.sample(5, "typing"), self.sample(20, "unknown"), self.sample(20, "busy")], tolerance_ms=3 * S)
        self.assertEqual(r["agree"], 2)  # idle~typing, awaiting_approval~busy (the modal keeps the turn open)
        self.assertEqual(r["pane_unknown"], 1)

    def test_nothing_observed_means_no_rate(self):
        r = st.compare([], [self.sample(5, "idle")], tolerance_ms=3 * S)
        self.assertIsNone(r["agreement"])


class Parse(unittest.TestCase):
    def test_log_lines_parse_and_garbage_is_skipped(self):
        evs = st.parse_events("1000\tUserPromptSubmit\t\nbroken\n2000\tPreToolUse\tBash\n3000\tNotification\tperm\n")
        self.assertEqual([(e["ts"], e["event"], e["extra"]) for e in evs], [(1000, "UserPromptSubmit", ""), (2000, "PreToolUse", "Bash"), (3000, "Notification", "perm")])
        self.assertEqual(st.parse_samples("1000\tidle\n2000\tbusy\nbad\n"), [{"ts": 1000, "state": "idle"}, {"ts": 2000, "state": "busy"}])


class HookScript(unittest.TestCase):
    def run_hook(self, payload, agent="darryl", agents=None, files=()):
        d = tempfile.mkdtemp()
        for f in files:
            open(os.path.join(d, f), "w").close()
        env = {"PATH": os.environ["PATH"], "OFFICE_AGENT_ID": agent, "AGENT_STATE_DIR": d}
        if agents is not None:
            env["AGENT_STATE_AGENTS"] = agents
        r = subprocess.run(["sh", HOOK], input=json.dumps(payload), capture_output=True, text=True, env=env)
        return r, d

    def test_trial_agent_event_is_appended_and_hook_prints_nothing_and_exits_0(self):
        r, d = self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "secret thing"}})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        line = open(os.path.join(d, "darryl.events.log")).read()
        self.assertIn("\tPreToolUse\tBash", line)
        self.assertNotIn("secret", line)  # tool input is never recorded

    def test_other_agents_write_nothing(self):
        r, d = self.run_hook({"hook_event_name": "Stop"}, agent="toby")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(os.listdir(d), [])

    def test_disable_files_pause_it(self):
        _, d = self.run_hook({"hook_event_name": "Stop"}, files=["DISABLE"])
        self.assertEqual([f for f in os.listdir(d) if f.endswith(".log")], [])
        _, d2 = self.run_hook({"hook_event_name": "Stop"}, files=["DISABLE-darryl"])
        self.assertEqual([f for f in os.listdir(d2) if f.endswith(".log")], [])

    def test_notification_class_is_recorded_but_never_the_message_text(self):
        _, d = self.run_hook({"hook_event_name": "Notification", "message": "Claude needs your permission to use Bash for the owner private thing"})
        line = open(os.path.join(d, "darryl.events.log")).read()
        self.assertIn("\tNotification\tperm", line)
        self.assertNotIn("private", line)
        _, d2 = self.run_hook({"hook_event_name": "Notification", "message": "Claude is waiting for your input"})
        self.assertIn("\tNotification\tidle", open(os.path.join(d2, "darryl.events.log")).read())

    def test_garbage_stdin_still_exits_0_silently(self):
        d = tempfile.mkdtemp()
        r = subprocess.run(["sh", HOOK], input="not json at all", capture_output=True, text=True, env={"PATH": os.environ["PATH"], "OFFICE_AGENT_ID": "darryl", "AGENT_STATE_DIR": d})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_allowlist_can_name_more_agents(self):
        _, d = self.run_hook({"hook_event_name": "Stop"}, agent="toby", agents="darryl,toby")
        self.assertTrue(os.path.exists(os.path.join(d, "toby.events.log")))



class Install(unittest.TestCase):
    def test_adds_all_events_idempotently_keeps_other_hooks_and_removes_cleanly(self):
        import install_hook as ih
        other = {"matcher": "*", "hooks": [{"type": "command", "command": "sh /x/fleet-freeze/freeze-hook.sh /f"}]}
        cur = {"model": "m", "hooks": {"PreToolUse": [other], "Stop": [{"hooks": [{"type": "command", "command": "other-stop"}]}]}}
        once = ih.apply(cur, "/e", "/t")
        self.assertEqual(once, ih.apply(once, "/e", "/t"))
        self.assertEqual(set(once["hooks"]), set(ih.EVENTS))
        self.assertEqual(once["hooks"]["PreToolUse"][0], other)   # the freeze hook stays first
        self.assertEqual(len(once["hooks"]["Stop"]), 2)
        self.assertIn("AGENT_STATE_DIR=/t/store/agent-state sh /e/tools/agent-state/agent-state-hook.sh", json.dumps(once))
        self.assertEqual(ih.apply(once, "/e", "/t", remove=True), cur)


if __name__ == "__main__":
    unittest.main()

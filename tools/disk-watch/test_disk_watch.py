"""Red-first tests for disk-watch: pure hysteresis, message text, state persistence, exit codes.

Run: python3 -m unittest discover -s tools/disk-watch -p 'test_*.py'
"""
import json
import os
import tempfile
import unittest

import disk_watch as dw

NOW = 1_800_000_000
WARN, CRIT = 50.0, 20.0


def step(prev, free, now=NOW):
    return dw.decide(prev, free, now, WARN, CRIT)


class Levels(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(dw.level_of(80, WARN, CRIT), "ok")
        self.assertEqual(dw.level_of(49.9, WARN, CRIT), "warn")
        self.assertEqual(dw.level_of(19.9, WARN, CRIT), "crit")
        self.assertEqual(dw.level_of(50.0, WARN, CRIT), "ok")  # the threshold itself is still ok


class Hysteresis(unittest.TestCase):
    def test_ok_to_warn_alerts_once(self):
        s, kind = step({}, 45)
        self.assertEqual((s["level"], kind), ("warn", "warn"))
        s2, kind2 = step(s, 44, NOW + 900)
        self.assertEqual((s2["level"], kind2), ("warn", None))

    def test_warn_to_crit_alerts_immediately(self):
        s, _ = step({}, 45)
        s2, kind = step(s, 15, NOW + 900)
        self.assertEqual((s2["level"], kind), ("crit", "crit"))

    def test_crit_repeats_only_after_the_repeat_window(self):
        s, _ = step({}, 15)
        _, kind = step(s, 14, NOW + dw.CRIT_REPEAT_S - 1)
        self.assertIsNone(kind)
        s3, kind3 = step(s, 14, NOW + dw.CRIT_REPEAT_S)
        self.assertEqual(kind3, "crit")
        self.assertEqual(s3["alerted_at"], NOW + dw.CRIT_REPEAT_S)

    def test_recovery_needs_the_margin_and_says_so_once(self):
        s, _ = step({}, 15)
        s2, kind = step(s, 55, NOW + 100)  # above warn but inside the margin: keep the worse level, quiet
        self.assertEqual((s2["level"], kind), ("crit", None))
        s3, kind3 = step(s2, 61, NOW + 200)  # warn + margin
        self.assertEqual((s3["level"], kind3), ("ok", "recovered"))
        s4, kind4 = step(s3, 70, NOW + 300)
        self.assertEqual((s4["level"], kind4), ("ok", None))

    def test_flapping_around_warn_is_silent(self):
        s, _ = step({}, 45)
        for i, free in enumerate([51, 49, 52, 48, 55, 47]):
            s, kind = step(s, free, NOW + 60 * (i + 1))
            self.assertIsNone(kind)

    def test_garbage_state_is_treated_as_ok(self):
        s, kind = step({"level": "bogus", "alerted_at": "x"}, 90)
        self.assertEqual((s["level"], kind), ("ok", None))


class Message(unittest.TestCase):
    def test_text_names_level_free_space_and_never_offers_deletion(self):
        m = dw.message("crit", 12.3, 500.0, WARN, CRIT, "/data")
        self.assertIn("CRITICAL", m)
        self.assertIn("12.3 GB", m)
        self.assertIn("/data", m)
        self.assertNotIn("rm ", m)
        self.assertNotIn("—", m)  # no em dash in anything we send

    def test_recovered_text(self):
        self.assertIn("back to normal", dw.message("recovered", 70, 500.0, WARN, CRIT, "/data"))


class Main(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.state = os.path.join(self.d, "disk-watch.json")
        self.sent = []

    def run_main(self, free, **kw):
        poster = kw.pop("poster", lambda to, text: self.sent.append((to, text)) or True)
        return dw.main(["--state", self.state, "--free-gb", str(free)], poster=poster, now=kw.pop("now", NOW))

    def test_alert_goes_to_the_configured_agent_and_state_is_saved(self):
        self.assertEqual(self.run_main(30), 0)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][0], "marveen")
        self.assertTrue(self.sent[0][1].startswith("[disk-watch]"))
        self.assertEqual(json.load(open(self.state))["level"], "warn")

    def test_second_run_same_level_sends_nothing(self):
        self.run_main(30)
        self.run_main(29, now=NOW + 900)
        self.assertEqual(len(self.sent), 1)

    def test_a_failed_send_does_not_consume_the_alert(self):
        self.run_main(30, poster=lambda to, text: False)
        self.assertFalse(os.path.exists(self.state))  # state NOT advanced: retried next run
        self.run_main(30, now=NOW + 900)
        self.assertEqual(len(self.sent), 1)

    def test_cannot_measure_exits_1(self):
        self.assertEqual(dw.main(["--state", self.state, "--path", "/nonexistent/zzz"], poster=lambda *a: True, now=NOW), 1)

    def test_dry_run_sends_and_saves_nothing(self):
        dw.main(["--state", self.state, "--free-gb", "5", "--dry-run"], poster=lambda *a: self.sent.append(a) or True, now=NOW)
        self.assertEqual(self.sent, [])
        self.assertFalse(os.path.exists(self.state))


if __name__ == "__main__":
    unittest.main()

"""Red-first tests for agent-msg: a send counts only if the bus answered HTTP 200 with an id."""
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import agent_msg as am


class Bus(BaseHTTPRequestHandler):
    script = []          # list of (status, body) answers, consumed in order; last one repeats
    seen = []            # (path, auth, json body)
    agents = [{"id": "marveen"}, {"id": "toby"}, {"id": "darryl"}]

    def log_message(self, *a): pass

    def _send(self, status, body):
        data = json.dumps(body).encode() if not isinstance(body, bytes) else body
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        self._send(200, Bus.agents)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        Bus.seen.append((self.path, self.headers.get("Authorization"), json.loads(self.rfile.read(n))))
        status, body = Bus.script[0] if len(Bus.script) == 1 else Bus.script.pop(0)
        self._send(status, body)


class Base(unittest.TestCase):
    def setUp(self):
        Bus.script, Bus.seen = [(200, {"id": 41})], []
        self.srv = HTTPServer(("127.0.0.1", 0), Bus)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.tenant = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tenant, "store"))
        open(os.path.join(self.tenant, "store", ".dashboard-token"), "w").write("tok123\n")
        self.env = {"OFFICE_TENANT_ROOT": self.tenant, "OFFICE_PORT": str(self.srv.server_address[1]), "OFFICE_AGENT_ID": "darryl"}

    def tearDown(self):
        self.srv.shutdown()

    def send(self, argv, stdin="", **kw):
        out, err = io.StringIO(), io.StringIO()
        rc = am.main(argv, env=self.env, stdin=io.StringIO(stdin), stdout=out, stderr=err, sleep=lambda s: None, **kw)
        return rc, out.getvalue(), err.getvalue()


class Send(Base):
    def test_success_needs_200_and_an_id_and_prints_the_id(self):
        rc, out, _ = self.send(["marveen", "hello"])
        self.assertEqual(rc, 0)
        self.assertIn("id=41", out)
        path, auth, body = Bus.seen[0]
        self.assertEqual((path, auth), ("/api/messages", "Bearer tok123"))
        self.assertEqual(body, {"from": "darryl", "to": "marveen", "content": "hello"})

    def test_json_is_built_safely_for_quotes_newlines_and_dollar_signs(self):
        text = 'she said "hi"\nline2 $(rm -rf /) `x` \\ back'
        self.assertEqual(self.send(["marveen", text])[0], 0)
        self.assertEqual(Bus.seen[0][2]["content"], text)

    def test_content_from_stdin_with_dash(self):
        self.assertEqual(self.send(["marveen", "-"], stdin="multi\nline body")[0], 0)
        self.assertEqual(Bus.seen[0][2]["content"], "multi\nline body")

    def test_a_real_error_answer_is_not_retried_and_fails_loudly(self):
        for code in (400, 401, 500):
            Bus.script, Bus.seen = [(code, {"error": "no"})], []
            rc, out, err = self.send(["marveen", "hello"])
            self.assertEqual((rc, len(Bus.seen)), (1, 1), code)
            self.assertIn("NOT SENT", err)
        self.assertNotIn("sent id", out)

    def test_502_and_503_are_retried_up_to_three_times(self):
        Bus.script, Bus.seen = [(503, {"error": "busy"})], []
        rc, _, err = self.send(["marveen", "hello"])
        self.assertEqual((rc, len(Bus.seen)), (1, 3))
        Bus.script, Bus.seen = [(502, {}), (200, {"id": 9})], []
        self.assertEqual((self.send(["marveen", "hello"])[0], len(Bus.seen)), (0, 2))

    def test_a_read_timeout_is_never_retried_because_the_bus_may_have_accepted_it(self):
        import socket
        orig = am.urllib.request.urlopen
        calls = []
        def slow(req, timeout=None):
            if req.full_url.endswith("/api/agents"):
                return orig(req, timeout=timeout)
            calls.append(1)
            raise socket.timeout("timed out")
        am.urllib.request.urlopen = slow
        try:
            rc, out, err = self.send(["marveen", "hello"])
        finally:
            am.urllib.request.urlopen = orig
        self.assertEqual((rc, len(calls)), (2, 1))
        self.assertIn("UNKNOWN OUTCOME", err)
        self.assertNotIn("sent id", out)
        self.assertIn("timeout-unknown-outcome", open(os.path.join(self.tenant, "store", "agent-msg-failures.log")).read())

    def test_a_200_without_an_id_is_a_failure_and_not_repeated(self):
        Bus.script = [(200, {"ok": True})]
        rc, _, err = self.send(["marveen", "hello"])
        self.assertEqual((rc, len(Bus.seen)), (1, 1))
        self.assertIn("NOT SENT", err)

    def test_recovers_when_a_later_attempt_succeeds(self):
        Bus.script = [(503, {"error": "boom"}), (200, {"id": 7})]
        rc, out, _ = self.send(["marveen", "hello"])
        self.assertEqual((rc, len(Bus.seen)), (0, 2))
        self.assertIn("id=7", out)

    def test_an_unroutable_recipient_is_refused_before_sending(self):
        rc, _, err = self.send(["nobody-here", "hello"])
        self.assertEqual(rc, 1)
        self.assertEqual(Bus.seen, [])
        self.assertIn("nobody-here", err)

    def test_allow_unknown_sends_anyway(self):
        self.assertEqual(self.send(["--allow-unknown", "tool-x", "hello"])[0], 0)

    def test_from_defaults_to_the_agent_env_and_can_be_overridden(self):
        self.send(["--from", "toby", "marveen", "hi"])
        self.assertEqual(Bus.seen[0][2]["from"], "toby")

    def test_no_sender_identity_is_refused(self):
        self.env.pop("OFFICE_AGENT_ID")
        rc, _, err = self.send(["marveen", "hi"])
        self.assertEqual(rc, 1)
        self.assertIn("sender", err.lower())

    def test_failures_are_logged_without_the_message_text_or_token(self):
        Bus.script = [(401, {"error": "unauthorized"})]
        self.send(["marveen", "TOP SECRET PAYLOAD"])
        log = open(os.path.join(self.tenant, "store", "agent-msg-failures.log")).read()
        self.assertIn("marveen", log)
        self.assertIn("401", log)
        self.assertNotIn("TOP SECRET", log)
        self.assertNotIn("tok123", log)

    def test_unreachable_bus_is_retried_three_times_then_fails_loudly(self):
        self.srv.shutdown()
        self.srv.server_close()  # really closed: connection refused, nothing was sent
        slept = []
        out, err = io.StringIO(), io.StringIO()
        rc = am.main(["--allow-unknown", "marveen", "hi"], env=self.env, stdin=io.StringIO(""), stdout=out, stderr=err, sleep=slept.append)
        self.assertEqual(rc, 1)
        self.assertEqual(slept, [1, 2])  # three attempts, two waits
        self.assertIn("NOT SENT", err.getvalue())


class Observer(unittest.TestCase):
    def test_a_bus_row_stuck_queued_in_the_inbound_queue_counts_too_but_owner_channel_rows_do_not(self):
        import sqlite3
        import stall_check as sc
        d = tempfile.mkdtemp()
        db = os.path.join(d, "t.db")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, status TEXT, created_at INTEGER)")
        c.execute("CREATE TABLE inbound_queue (id INTEGER PRIMARY KEY, agent_id TEXT, source TEXT, status TEXT, created_at INTEGER)")
        now = 10_000_000
        c.executemany("INSERT INTO inbound_queue (agent_id,source,status,created_at) VALUES (?,?,?,?)",
                      [("marveen", "bus", "queued", now - 3600), ("marveen", "bus", "delivered", now - 3600),
                       ("marveen", "channel", "queued", now - 3600), ("marveen", "scheduler", "queued", now - 3600), ("toby", "bus", "queued", now - 3600)])
        c.commit(); c.close()
        sent = []
        r = sc.check(db, "marveen", os.path.join(d, "s.json"), now, 1800, 3600, lambda t: sent.append(t) or True)
        self.assertEqual(r["stalled"], 1)  # only the bus row still queued

    def test_main_inbox_stall_finds_old_pending_rows_and_alerts_once_per_cooldown(self):
        import sqlite3
        import stall_check as sc
        d = tempfile.mkdtemp()
        db = os.path.join(d, "t.db")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, status TEXT, created_at INTEGER)")
        now = 10_000_000
        c.executemany("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES (?,?,?,?,?)",
                      [("a", "marveen", "old", "pending", now - 3600), ("a", "marveen", "fresh", "pending", now - 60),
                       ("a", "marveen", "done", "done", now - 7200), ("a", "toby", "other", "pending", now - 7200)])
        c.commit(); c.close()
        state = os.path.join(d, "state.json")
        sent = []
        r1 = sc.check(db, "marveen", state, now, 1800, 3600, lambda text: sent.append(text) or True)
        self.assertEqual(r1["stalled"], 1)
        self.assertEqual(len(sent), 1)
        r2 = sc.check(db, "marveen", state, now + 600, 1800, 3600, lambda text: sent.append(text) or True)
        self.assertEqual(len(sent), 1)  # cooldown: not again within the hour
        sc.check(db, "marveen", state, now + 3700, 1800, 3600, lambda text: sent.append(text) or True)
        self.assertEqual(len(sent), 2)
        self.assertTrue(os.path.exists(state))

    def test_a_failed_alert_is_retried_and_a_quiet_inbox_alerts_nothing(self):
        import sqlite3
        import stall_check as sc
        d = tempfile.mkdtemp()
        db = os.path.join(d, "t.db")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, status TEXT, created_at INTEGER)")
        c.execute("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at) VALUES ('a','marveen','old','pending',1)")
        c.commit(); c.close()
        state = os.path.join(d, "state.json")
        sc.check(db, "marveen", state, 10_000, 1800, 3600, lambda text: False)  # delivery failed
        sent = []
        sc.check(db, "marveen", state, 10_060, 1800, 3600, lambda text: sent.append(text) or True)
        self.assertEqual(len(sent), 1)  # the failed alert did not consume the cooldown
        q = os.path.join(d, "q.db"); sqlite3.connect(q).execute("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, status TEXT, created_at INTEGER)").connection.commit()
        quiet = []
        self.assertEqual(sc.check(q, "marveen", os.path.join(d, "s2.json"), 10_000, 1800, 3600, lambda t: quiet.append(t) or True)["stalled"], 0)
        self.assertEqual(quiet, [])



class WatchdogAlertSemantics(unittest.TestCase):
    def test_the_watchdog_alert_counts_as_sent_only_with_an_integer_id(self):
        import importlib.util
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("ow", os.path.join(os.path.dirname(here), "owner-watchdog", "owner_watchdog.py"))
        ow = importlib.util.module_from_spec(spec)
        os.environ.setdefault("OFFICE_TENANT_ROOT", tempfile.mkdtemp())
        spec.loader.exec_module(ow)
        self.assertTrue(ow._bus_accepted('{"id": 12}'))
        for bad in ('{"ok": true}', '{"id": "12"}', "<html>", "", None, "[1]"):
            self.assertFalse(ow._bus_accepted(bad), bad)


if __name__ == "__main__":
    unittest.main()

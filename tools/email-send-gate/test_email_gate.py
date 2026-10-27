"""Red-first tests for the email send gate (PreToolUse hook + approval tokens + replay).

Run: python3 -m unittest discover -s tools/email-send-gate -p 'test_*.py'
"""
import io
import json
import os
import tempfile
import unittest

import email_gate as g

NOW = 1_800_000_000
GMAIL_SEND = "mcp__claude_ai_Gmail__send_message"
MB_DRAFT = "mcp__claude_ai_Mailbox_MCP__send_draft"
MB_SEND = "mcp__claude_ai_Mailbox_MCP__send_email"


class Classify(unittest.TestCase):
    def test_send_tools_are_recognised_and_drafts_are_not(self):
        for name in (GMAIL_SEND, "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward", MB_SEND, MB_DRAFT,
                     "mcp__claude_ai_Mailbox_MCP__reply_email", "mcp__claude_ai_Mailbox_MCP__forward_email"):
            self.assertIsNotNone(g.classify(name, {"to": ["a@example.com"], "subject": "s", "body": "b", "uid": 1}), name)
        for name in ("mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Mailbox_MCP__draft_email", "mcp__claude_ai_Mailbox_MCP__draft_reply",
                     "mcp__claude_ai_Mailbox_MCP__update_draft", "mcp__claude_ai_Mailbox_MCP__read_email", "Read", "Edit"):
            self.assertIsNone(g.classify(name, {"uid": 1}), name)

    def test_key_is_stable_across_field_order_recipient_case_and_whitespace(self):
        a = g.classify(GMAIL_SEND, {"to": ["B@Example.com", "a@example.com"], "subject": "Hi", "body": "line one\n\nline  two "})
        b = g.classify(GMAIL_SEND, {"body": "line one line two", "subject": "Hi", "to": ["a@example.com", "b@example.com"]})
        self.assertEqual(a["key"], b["key"])

    def test_any_change_to_recipient_subject_or_body_changes_the_key(self):
        base = {"to": ["a@example.com"], "subject": "Hi", "body": "text"}
        k = g.classify(GMAIL_SEND, base)["key"]
        for patch in ({"to": ["x@example.com"]}, {"subject": "Hi!"}, {"body": "text."}, {"cc": ["c@example.com"]}):
            self.assertNotEqual(k, g.classify(GMAIL_SEND, {**base, **patch})["key"], patch)

    def test_send_draft_is_keyed_by_the_draft_uid(self):
        self.assertEqual(g.classify(MB_DRAFT, {"uid": 670})["key"], g.classify(MB_DRAFT, {"uid": 670})["key"])
        self.assertNotEqual(g.classify(MB_DRAFT, {"uid": 670})["key"], g.classify(MB_DRAFT, {"uid": 671})["key"])

    def test_bash_only_when_it_actually_sends_mail(self):
        yes = ["curl -s -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send -H x",
               "python3 -c 'import smtplib; s = smtplib.SMTP(\"h\"); s.sendmail(a,b,c)'",
               "curl https://gmail.googleapis.com/gmail/v1/users/me/drafts/send -d x", "sendmail -t < msg.txt",
               "python3 - <<'EOF'\nimport urllib.request\nr=urllib.request.urlopen(urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',data=b'x'))\nEOF",
               "cd /tmp && python3 - <<'EOF'\nr=req(\"https://gmail.googleapis.com/gmail/v1/users/me/drafts/send\",t,{})\nEOF".replace("req(", "requests.post(")]
        no = ["ls -la", "git log --oneline", "grep -r send_message src", "curl -s https://gmail.googleapis.com/gmail/v1/users/me/messages?q=x",
              "python3 tools/crm-notes-dispatch/dispatch.py", "cat notes.txt",
              "grep -rn \"messages/send\\|drafts/send\\|smtplib\\|sendmail\" tools/",
              "git commit -m 'use the Gmail API messages/send endpoint via smtplib wrapper'",
              "python3 - <<'EOF'\ns=open('d.py').read()\ns=s.replace('a','x')\nr=urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')\nopen('d.py','w').write(s)\nEOF",
              "cat > t.py <<'EOF'\nr=urllib.request.urlopen(urllib.request.Request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send'))\nEOF"]
        for c in yes:
            self.assertIsNotNone(g.classify("Bash", {"command": c}), c)
        for c in no:
            self.assertIsNone(g.classify("Bash", {"command": c}), c)

    def test_label_never_contains_the_body(self):
        c = g.classify(GMAIL_SEND, {"to": ["a@example.com"], "subject": "Subj", "body": "SECRET BODY TEXT"})
        self.assertNotIn("SECRET", c["label"])
        self.assertIn("a@example.com", c["label"])


class Decide(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.args = {"to": ["a@example.com"], "subject": "Hi", "body": "text"}

    def decide(self, mode="enforce", now=NOW, args=None, tool=GMAIL_SEND):
        return g.decide(tool, args or self.args, self.d, mode, now)

    def test_not_an_email_send_is_allowed_untouched(self):
        self.assertEqual(g.decide("Read", {"file_path": "/x"}, self.d, "enforce", NOW)["action"], "allow")

    def test_enforce_denies_without_a_token_and_says_how_to_approve(self):
        r = self.decide()
        self.assertEqual(r["action"], "deny")
        self.assertIn("approval", r["reason"].lower())
        self.assertIn("email_gate", r["reason"])

    def test_a_matching_token_allows_once_then_is_spent(self):
        g.approve(self.d, GMAIL_SEND, self.args, by="marveen", now=NOW)
        self.assertEqual(self.decide()["action"], "allow")
        self.assertEqual(self.decide()["action"], "deny")  # one-shot

    def test_a_token_for_a_different_draft_does_not_unlock_this_one(self):
        g.approve(self.d, GMAIL_SEND, {**self.args, "body": "other text"}, by="marveen", now=NOW)
        self.assertEqual(self.decide()["action"], "deny")

    def test_an_expired_token_does_not_unlock(self):
        g.approve(self.d, GMAIL_SEND, self.args, by="marveen", now=NOW, ttl_min=30)
        self.assertEqual(self.decide(now=NOW + 31 * 60)["action"], "deny")

    def test_a_denied_attempt_does_not_consume_a_valid_token_for_another_draft(self):
        g.approve(self.d, GMAIL_SEND, self.args, by="marveen", now=NOW)
        self.decide(args={**self.args, "subject": "different"})
        self.assertEqual(self.decide()["action"], "allow")

    def test_log_mode_never_blocks_but_records_what_it_would_have_done(self):
        r = self.decide(mode="log")
        self.assertEqual(r["action"], "allow")
        self.assertTrue(r["would_deny"])
        g.approve(self.d, GMAIL_SEND, self.args, by="marveen", now=NOW)
        r2 = self.decide(mode="log")
        self.assertEqual(r2["action"], "allow")
        self.assertFalse(r2["would_deny"])
        self.assertTrue(r2["token_matched"])

    def test_log_mode_does_not_consume_the_token(self):
        g.approve(self.d, GMAIL_SEND, self.args, by="marveen", now=NOW)
        self.decide(mode="log")
        self.assertEqual(self.decide(mode="enforce")["action"], "allow")

    def test_send_draft_token_by_uid(self):
        g.approve(self.d, MB_DRAFT, {"uid": 670}, by="marveen", now=NOW)
        self.assertEqual(g.decide(MB_DRAFT, {"uid": 670}, self.d, "enforce", NOW)["action"], "allow")
        self.assertEqual(g.decide(MB_DRAFT, {"uid": 671}, self.d, "enforce", NOW)["action"], "deny")

    def test_decisions_are_appended_to_the_log_without_bodies(self):
        self.decide(mode="log")
        line = open(os.path.join(self.d, "email-gate.log.jsonl")).read().strip().splitlines()[-1]
        rec = json.loads(line)
        self.assertEqual(rec["tool"], GMAIL_SEND)
        self.assertNotIn("text", rec["label"].replace("a@example.com", ""))
        self.assertNotIn('"body"', line)


class Hook(unittest.TestCase):
    def run_hook(self, payload, mode, d):
        out = io.StringIO()
        rc = g.hook_main(io.StringIO(json.dumps(payload)), out, store=d, mode=mode, now=NOW)
        return rc, out.getvalue()

    def test_deny_is_a_pretooluse_permission_decision(self):
        d = tempfile.mkdtemp()
        rc, out = self.run_hook({"tool_name": GMAIL_SEND, "tool_input": {"to": ["a@example.com"], "subject": "s", "body": "b"}}, "enforce", d)
        self.assertEqual(rc, 0)
        o = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(o["hookEventName"], "PreToolUse")
        self.assertEqual(o["permissionDecision"], "deny")

    def test_allow_prints_nothing(self):
        d = tempfile.mkdtemp()
        rc, out = self.run_hook({"tool_name": "Read", "tool_input": {}}, "enforce", d)
        self.assertEqual((rc, out), (0, ""))

    def test_garbage_input_fails_open(self):
        d = tempfile.mkdtemp()
        out = io.StringIO()
        self.assertEqual(g.hook_main(io.StringIO("not json"), out, store=d, mode="enforce", now=NOW), 0)
        self.assertEqual(out.getvalue(), "")

    def test_mode_file_selects_log_or_enforce_and_defaults_to_log(self):
        d = tempfile.mkdtemp()
        self.assertEqual(g.read_mode(d), "log")
        open(os.path.join(d, "email-gate.mode"), "w").write("enforce\n")
        self.assertEqual(g.read_mode(d), "enforce")
        open(os.path.join(d, "email-gate.mode"), "w").write("garbage")
        self.assertEqual(g.read_mode(d), "log")  # anything unrecognised is the safe, non-blocking mode


class Replay(unittest.TestCase):
    def test_replay_counts_sends_from_transcript_lines(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.jsonl")
        mk = lambda name, inp: json.dumps({"timestamp": "2026-10-25T10:00:00Z", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}})
        with open(p, "w") as f:
            f.write(mk(GMAIL_SEND, {"to": ["a@example.com"], "subject": "s", "body": "b"}) + "\n")
            f.write(mk(MB_DRAFT, {"uid": 5}) + "\n")
            f.write(mk("Read", {"file_path": "/x"}) + "\n")
            f.write(mk("Bash", {"command": "ls"}) + "\n")
        r = g.replay([p])
        self.assertEqual(r["sends"], 2)
        self.assertEqual(r["by_tool"][GMAIL_SEND], 1)
        self.assertEqual(r["by_tool"][MB_DRAFT], 1)



class InstallHook(unittest.TestCase):
    def test_adds_once_keeps_everything_else_and_removes_cleanly(self):
        import install_hook as ih
        cur = {"model": "x", "hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "other"}]}], "Stop": [{"hooks": []}]}}
        once = ih.apply(cur, "/e")
        twice = ih.apply(once, "/e")
        self.assertEqual(once, twice)  # idempotent
        self.assertEqual(once["model"], "x")
        self.assertEqual(once["hooks"]["Stop"], cur["hooks"]["Stop"])
        self.assertEqual(len(once["hooks"]["PreToolUse"]), 2)
        self.assertIn("/e/tools/email-send-gate/email_gate.py hook", json.dumps(once))
        self.assertEqual(ih.apply(once, "/e", remove=True), cur)  # remove restores the original
        self.assertNotIn("hooks", ih.apply({"hooks": {"PreToolUse": once["hooks"]["PreToolUse"][1:]}}, "/e", remove=True))

    def test_matcher_covers_every_send_tool_and_no_draft_tool(self):
        import re
        import install_hook as ih
        rx = re.compile("^(" + ih.MATCHER + ")$")
        for t in ("Bash", "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward", "mcp__claude_ai_Mailbox_MCP__send_email",
                  "mcp__claude_ai_Mailbox_MCP__send_draft", "mcp__claude_ai_Mailbox_MCP__reply_email", "mcp__claude_ai_Mailbox_MCP__forward_email"):
            self.assertTrue(rx.match(t), t)
        for t in ("mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Mailbox_MCP__draft_reply", "Read"):
            self.assertFalse(rx.match(t), t)


if __name__ == "__main__":
    unittest.main()

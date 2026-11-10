"""owner_ack_guard.needs_no_reply: the strict closer detector, including the Slack location header of PR #32. python3 -m unittest test_owner_ack_guard"""
import importlib.util, os, unittest
spec = importlib.util.spec_from_file_location("owner_ack_guard", os.path.join(os.path.dirname(os.path.abspath(__file__)), "owner_ack_guard.py"))
og = importlib.util.module_from_spec(spec); spec.loader.exec_module(og)

class T(unittest.TestCase):
    def test_plain_closers_and_questions(self):
        for t in ("ok", "thanks!", "👍", "rendben"):
            self.assertTrue(og.needs_no_reply(t), t)
        for t in ("ok?", "status", "what now?", "please send it"):
            self.assertFalse(og.needs_no_reply(t), t)

    def test_a_leading_slack_location_header_is_ignored(self):
        for hdr in ("[Slack DM: channel D123]", "[Slack channel: channel C9]", "[Slack DM: channel D1, thread reply (thread_ts 1.1)]"):
            for t in ("ok", "thanks!", "rendben"):
                self.assertTrue(og.needs_no_reply(hdr + "\n" + t), hdr + t)
            self.assertFalse(og.needs_no_reply(hdr + "\nwhat is the status?"))
            self.assertFalse(og.needs_no_reply(hdr + "\nplease send the report"))
        self.assertTrue(og.needs_no_reply("[Slack DM: channel D1]"), "a header with no text is empty = no reply needed, like an empty prompt")

    def test_a_header_shaped_line_inside_a_message_is_not_stripped(self):
        self.assertFalse(og.needs_no_reply("do this [Slack DM: channel D1] then ok"))

if __name__ == "__main__":
    unittest.main()

import os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
import owner_watchdog as ow

OLD = (":rotating_light: CAPTAIN MODE (Claude is out, you act for Michael with his hard rules; read the CAPTAIN MODE section of your AGENTS.md). "
       ":rotating_light: Start every message to the owner with 'Emergency captain (Pete):'. The original message follows.\n\n")

class Preview(unittest.TestCase):
    """2026-11-11 captain review (bus 28878): the alert showed only the first ~60 chars of the captain wrapper, never the owner's text."""
    def test_a_captain_wrapped_prompt_previews_the_owner_text_not_the_wrapper(self):
        p = ow.preview(OLD + "Tenerife budget: add the second meetup and give me the total please")
        self.assertTrue(p.startswith("Tenerife budget"), p); self.assertNotIn("CAPTAIN MODE", p)
    def test_the_new_owner_first_shape_previews_the_owner_text(self):
        p = ow.preview("Add a colleague to the policy\n\n---\n:rotating_light: CAPTAIN MODE (Claude is out, you act for Michael). The text ABOVE the line is the original message.")
        self.assertEqual(p, "Add a colleague to the policy")
    def test_the_owner_text_is_shown_in_full_up_to_a_generous_limit(self):
        text = "word " * 70                                   # 350 chars
        self.assertEqual(ow.preview(text), " ".join(text.split()))
    def test_a_very_long_message_is_still_cut(self):
        self.assertTrue(ow.preview("x" * 5000).endswith("…")); self.assertLess(len(ow.preview("x" * 5000)), 1000)

if __name__ == "__main__": unittest.main()

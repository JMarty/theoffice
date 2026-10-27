import unittest

import rolling_reset as rr


class Order(unittest.TestCase):
    def test_last_agents_go_to_the_end_in_the_given_order(self):
        self.assertEqual(rr.order(["marveen", "toby", "darryl", "cfo", "pam"], ["darryl", "marveen"]), ["cfo", "pam", "toby", "darryl", "marveen"])

    def test_a_last_agent_that_does_not_exist_is_ignored_and_nothing_is_dropped_or_duplicated(self):
        r = rr.order(["a", "b", "marveen"], ["ghost", "marveen"])
        self.assertEqual(r, ["a", "b", "marveen"])
        self.assertEqual(len(r), len(set(r)))

    def test_no_last_is_plain_sorted(self):
        self.assertEqual(rr.order(["c", "a", "b"], []), ["a", "b", "c"])


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ctf_coord


class ParseCoordinationTest(unittest.TestCase):
    TEAMMATES = {"RY_1", "RY_2"}

    def test_parses_teammate_claim(self):
        self.assertEqual(
            ctf_coord.parse_coordination("<RY_1> [CTFC] c -14,-22", "RY_2", self.TEAMMATES),
            ("RY_1", "c", "-14,-22"),
        )

    def test_drops_own_lines_opponent_lines_system_and_chat(self):
        self.assertIsNone(ctf_coord.parse_coordination("<RY_2> [CTFC] c 1,2", "RY_2", self.TEAMMATES))
        self.assertIsNone(ctf_coord.parse_coordination("<BJ_1> [CTFC] c 1,2", "RY_2", self.TEAMMATES))
        self.assertIsNone(ctf_coord.parse_coordination("[CTF] RY_1 被抓捕并关入 左 队监狱。", "RY_2", self.TEAMMATES))
        self.assertIsNone(ctf_coord.parse_coordination("<RY_1> go flag 14.8,2.3 (claimed)", "RY_2", self.TEAMMATES))

    def test_requires_roster(self):
        self.assertIsNone(ctf_coord.parse_coordination("<RJ_1> [CTFC] r RY_2", "RY_2", self.TEAMMATES))
        self.assertIsNone(ctf_coord.parse_coordination("<RY_1> [CTFC] f", "RY_2", None))

    def test_claim_key_rounds_to_block_coordinates(self):
        self.assertEqual(ctf_coord.claim_key(14.0, -22.0), "14,-22")
        self.assertEqual(ctf_coord.claim_key(13.999, -21.6), "14,-22")

    def test_wire_format_matches_node_bots(self):
        self.assertEqual(ctf_coord.CHAT_PREFIX, "[CTFC]")
        self.assertEqual(ctf_coord.claim_message("14,-22"), "c 14,-22")
        self.assertEqual(ctf_coord.unclaim_message("14,-22"), "u 14,-22")
        self.assertEqual(ctf_coord.rescue_message("RJ_1"), "r RJ_1")
        self.assertEqual(ctf_coord.freed_message(), "f")
        # The Node module emits the same wire format; parse one of its lines.
        self.assertEqual(
            ctf_coord.parse_coordination("<RY_1> [CTFC] u 14,-22", "RY_2", self.TEAMMATES),
            ("RY_1", "u", "14,-22"),
        )


if __name__ == "__main__":
    unittest.main()

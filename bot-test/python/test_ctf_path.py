import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ctf_path

# 9x9 grid, origin (0,0): a wall column at x=4 with a single gap at z=6.
WALL_ROWS = [
    "....#....",
    "....#....",
    "....#....",
    "....#....",
    "....#....",
    "....#....",
    ".........",
    "....#....",
    "....#....",
]
ORIGIN = (0, 0)


class FindPathTest(unittest.TestCase):
    def test_returns_goal_centre_when_line_clear(self):
        open_rows = [".........", "........."]
        self.assertEqual(ctf_path.find_path(open_rows, ORIGIN, (1, 0), (8, 1)), [(8.5, 1.5)])

    def test_detours_around_wall_through_gap(self):
        path = ctf_path.find_path(WALL_ROWS, ORIGIN, (1, 1), (7, 1))
        self.assertIsNotNone(path)
        self.assertEqual(path[-1], (7.5, 1.5))
        for x, z in path:
            cx, cz = int(math.floor(x)), int(math.floor(z))
            self.assertTrue(ctf_path._passable(WALL_ROWS, ORIGIN, cx, cz), f"{x},{z} walkable")
        for x, z in path:
            if int(math.floor(x)) in (4, 5):
                self.assertIn(int(math.floor(z)), (5, 6, 7), f"crossing near gap at {x},{z}")

    def test_none_for_enclosed_or_blocked_ends(self):
        boxed = [
            ".........",
            ".#######.",
            ".#.....#.",
            ".#.....#.",
            ".#.....#.",
            ".#######.",
            ".........",
        ]
        self.assertIsNone(ctf_path.find_path(boxed, ORIGIN, (1, 1), (4, 3)))
        self.assertIsNone(ctf_path.find_path(WALL_ROWS, ORIGIN, (4, 0), (7, 1)))
        self.assertIsNone(ctf_path.find_path(WALL_ROWS, ORIGIN, (1, 1), (4, 4)))

    def test_smoothing_collapses_detour(self):
        path = ctf_path.find_path(WALL_ROWS, ORIGIN, (1, 1), (7, 1))
        self.assertLessEqual(len(path), 4)


if __name__ == "__main__":
    unittest.main()

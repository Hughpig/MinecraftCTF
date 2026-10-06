import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flag_state


class TakeNearestTest(unittest.TestCase):
    def test_pops_cell_nearest_to_picker(self):
        cells = {"4,10": {"x": 4, "z": 10}, "20,-30": {"x": 20, "z": -30}}
        self.assertEqual(flag_state.take_nearest(cells, 5, 9), {"x": 4, "z": 10})
        self.assertEqual(len(cells), 1)
        self.assertEqual(flag_state.take_nearest(cells, 20, -30), {"x": 20, "z": -30})
        self.assertEqual(len(cells), 0)
        self.assertIsNone(flag_state.take_nearest(cells, 0, 0))


if __name__ == "__main__":
    unittest.main()

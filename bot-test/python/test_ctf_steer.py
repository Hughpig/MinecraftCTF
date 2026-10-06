"""Unit tests for ctf_steer — mirrors bot-test/test/ctf-steer.test.js."""
import unittest

from ctf_steer import first_blocked_cell, plan_steer, strafe_side_for_away


def probe_for(solid):
    return lambda x, z, level: f"{x},{z}" in solid


def tree_at(cx, cz, target=None):
    solid = target if target is not None else set()
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            solid.add(f"{cx + dx},{cz + dz}")
    return solid


class TestSteer(unittest.TestCase):
    def test_clear_line_steers_straight(self):
        r = plan_steer({"x": 0, "z": 0}, {"x": 10, "z": 0}, None, probe_for(set()))
        self.assertEqual(r, {"steer_point": {"x": 10, "z": 0}, "detour": None})

    def test_only_two_high_walls_block(self):
        solid = tree_at(5, 0)
        self.assertEqual(first_blocked_cell(probe_for(solid), {"x": 2.5, "z": 0.5}, {"x": 10, "z": 0.5}), {"x": 4, "z": 0})
        single = lambda x, z, level: level == 0 and f"{x},{z}" in solid  # noqa: E731
        self.assertIsNone(first_blocked_cell(single, {"x": 2.5, "z": 0.5}, {"x": 10, "z": 0.5}))

    def test_tree_ahead_creates_detour_on_free_side(self):
        r = plan_steer({"x": 2.5, "z": 0.5}, {"x": 10, "z": 0.5}, None, probe_for(tree_at(5, 0)))
        self.assertEqual(r["detour"]["key"], "4,0")
        self.assertEqual(r["detour"]["side"], 1)
        self.assertAlmostEqual(r["steer_point"]["x"], 5.7)
        self.assertAlmostEqual(r["steer_point"]["z"], 3.7)

    def test_detour_holds_and_resumes(self):
        probe = probe_for(tree_at(5, 0))
        detour = {"key": "4,0", "blocked": {"x": 4, "z": 0}, "side": 1, "waypoint": {"x": 5.7, "z": 3.7}}
        holding = plan_steer({"x": 4, "z": 3}, {"x": 10, "z": 0.5}, detour, probe)
        self.assertEqual(holding["detour"]["key"], "4,0")
        resumed = plan_steer({"x": 8, "z": 3}, {"x": 10, "z": 0.5}, detour, probe)
        self.assertIsNone(resumed["detour"])

    def test_detour_clears_when_obstacle_gone(self):
        detour = {"key": "4,0", "blocked": {"x": 4, "z": 0}, "side": 1, "waypoint": {"x": 5.7, "z": 3.7}}
        r = plan_steer({"x": 4, "z": 3}, {"x": 10, "z": 0.5}, detour, probe_for(set()))
        self.assertIsNone(r["detour"])

    def test_blocked_both_sides_falls_back(self):
        solid = {f"{x},{z}" for x in range(4, 7) for z in range(-3, 4)}
        r = plan_steer({"x": 2.5, "z": 0.5}, {"x": 10, "z": 0.5}, None, probe_for(solid))
        self.assertIsNone(r["detour"])

    def test_detour_replans_for_new_obstacle(self):
        solid = tree_at(5, 0)
        tree_at(6, 2, solid)
        # Same stale waypoint as the JS test (pre-lateral-widening value).
        detour = {"key": "4,0", "blocked": {"x": 4, "z": 0}, "side": 1, "waypoint": {"x": 5.7, "z": 3.1}}
        r = plan_steer({"x": 4.5, "z": 2.5}, {"x": 10, "z": 0.5}, detour, probe_for(solid))
        self.assertEqual(r["detour"]["key"], "5,2")

    def test_strafe_side_moves_away(self):
        facing = {"x": 0, "z": -1}
        self.assertEqual(strafe_side_for_away(facing, {"x": -1, "z": 0}), "left")
        self.assertEqual(strafe_side_for_away(facing, {"x": 1, "z": 0}), "right")
        self.assertIsNone(strafe_side_for_away(facing, {"x": 0, "z": -1}))


if __name__ == "__main__":
    unittest.main()

"""Obstacle-aware steering — a faithful Python port of bot-test/ctf-steer.js.

Pure functions with an injectable block probe (probe(x, z, level) -> bool,
level 0 = feet, level 1 = head), so tests drive them on synthetic grids and a
future pathfinder can replace the internals without touching the callers.
"""

DETOUR_CLEAR_DISTANCE = 3.5
DETOUR_LATERAL = 3.2
DETOUR_FORWARD = 1.2
FLAG_STAND_SPACING = 4
STAND_TREE_MARGIN = 1


def _normalize(from_pos, target):
    dx = target["x"] - from_pos["x"]
    dz = target["z"] - from_pos["z"]
    length = (dx * dx + dz * dz) ** 0.5 or 1.0
    return {"x": dx / length, "z": dz / length, "len": (dx * dx + dz * dz) ** 0.5}


def is_two_high_wall(probe, x, z):
    return probe(x, z, 0) and probe(x, z, 1)


def first_blocked_cell(probe, from_pos, target, max_look=3.0):
    """First cell along the line whose feet AND head blocks are solid — a
    two-block wall the bot cannot jump over. Single-block obstacles stay the
    caller's jump concern."""
    unit = _normalize(from_pos, target)
    if unit["len"] < 0.01:
        return None
    limit = min(unit["len"] - 0.4, max_look)
    d = 0.6
    while d <= limit:
        x = int(from_pos["x"] + unit["x"] * d) // 1
        z = int(from_pos["z"] + unit["z"] * d) // 1
        x = int(x)
        z = int(z)
        if is_two_high_wall(probe, x, z):
            return {"x": x, "z": z}
        d += 0.5
    return None


def pick_side(probe, from_pos, target, blocked):
    unit = _normalize(from_pos, target)
    for side in (1, -1):
        x = int(blocked["x"] + 0.5 - unit["z"] * side * DETOUR_LATERAL)
        z = int(blocked["z"] + 0.5 + unit["x"] * side * DETOUR_LATERAL)
        if not probe(x, z, 0) and not probe(x, z, 1):
            return side
    return 0


def detour_waypoint(from_pos, target, blocked, side):
    unit = _normalize(from_pos, target)
    return {
        "x": blocked["x"] + 0.5 - unit["z"] * side * DETOUR_LATERAL + unit["x"] * DETOUR_FORWARD,
        "z": blocked["z"] + 0.5 + unit["x"] * side * DETOUR_LATERAL + unit["z"] * DETOUR_FORWARD,
    }


def plan_steer(position, target, detour, probe):
    """Decide where to steer this step. detour carries the obstacle being
    rounded; it clears once the straight line to the real target is open again
    and the obstacle is far enough behind."""
    if detour:
        away = ((position["x"] - (detour["blocked"]["x"] + 0.5)) ** 2
                + (position["z"] - (detour["blocked"]["z"] + 0.5)) ** 2) ** 0.5
        obstacle_gone = not probe(detour["blocked"]["x"], detour["blocked"]["z"], 0)
        if (not first_blocked_cell(probe, position, target) and away >= DETOUR_CLEAR_DISTANCE) or obstacle_gone:
            return {"steer_point": dict(target), "detour": None}
        next_blocked = first_blocked_cell(probe, position, detour["waypoint"], 2)
        if next_blocked and f"{next_blocked['x']},{next_blocked['z']}" != detour["key"]:
            side = pick_side(probe, position, detour["waypoint"], next_blocked)
            if side != 0:
                waypoint = detour_waypoint(position, detour["waypoint"], next_blocked, side)
                return {
                    "steer_point": waypoint,
                    "detour": {"key": f"{next_blocked['x']},{next_blocked['z']}",
                               "blocked": next_blocked, "side": side, "waypoint": waypoint},
                }
        return {"steer_point": detour["waypoint"], "detour": detour}
    blocked = first_blocked_cell(probe, position, target)
    if not blocked:
        return {"steer_point": dict(target), "detour": None}
    side = pick_side(probe, position, target, blocked)
    if side == 0:
        return {"steer_point": dict(target), "detour": None}
    waypoint = detour_waypoint(position, target, blocked, side)
    return {"steer_point": waypoint,
            "detour": {"key": f"{blocked['x']},{blocked['z']}", "blocked": blocked,
                       "side": side, "waypoint": waypoint}}


def strafe_side_for_away(facing, away):
    """Which strafe key moves the bot AWAY from the opponent while it faces the
    target. Returns 'left', 'right', or None when there is no lateral component."""
    left_x, left_z = facing["z"], -facing["x"]
    dot = away["x"] * left_x + away["z"] * left_z
    if abs(dot) < 0.1:
        return None
    return "left" if dot > 0 else "right"


def nearest_free_cell(probe, x, z, max_radius=3):
    """Nearest free cell to a hardcoded waypoint: spiral search so patrol
    targets that ended up inside a tree can still be reached."""
    if not is_two_high_wall(probe, x, z):
        return {"x": x, "z": z}
    for radius in range(1, max_radius + 1):
        for dx in range(-radius, radius + 1):
            for dz in range(-radius, radius + 1):
                if max(abs(dx), abs(dz)) != radius:
                    continue
                if not is_two_high_wall(probe, x + dx, z + dz):
                    return {"x": x + dx, "z": z + dz}
    return {"x": x, "z": z}


def chebyshev(x1, z1, x2, z2):
    return max(abs(x1 - x2), abs(z1 - z2))

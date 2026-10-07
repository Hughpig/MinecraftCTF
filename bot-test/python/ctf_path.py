"""Grid A* for the arena occupancy map. The grid is row strings from one
Node-side scan ('#' = feet block solid, '.' = clear), with origin (x0, z0) at
row[0][0]. Pure and mirrored by bot-test/ctf-path.js — same algorithm, same
tests. The arena is flat, so walkability is decided at feet level alone; the
local steering still owns avoidance, the path only supplies the global route.
"""

import heapq
import math

_STEPS = ((1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
          (1, 1, 1.42), (1, -1, 1.42), (-1, 1, 1.42), (-1, -1, 1.42))
BOT_HALF_WIDTH = 0.35


def _passable(rows, origin, x, z):
    x0, z0 = origin
    i, j = int(z) - z0, int(x) - x0
    if i < 0 or i >= len(rows):
        return False
    row = rows[i]
    if j < 0 or j >= len(row):
        return False
    return row[j] == "."


def _line_clear(rows, origin, a, b):
    """True when the swept bot box along segment a->b never touches a wall.
    Samples outside the grid are skipped: the grid stops one cell short of
    the arena walls, and A* nodes never leave it anyway."""
    ax, az = a
    bx, bz = b
    steps = int(max(abs(bx - ax), abs(bz - az)) * 4) + 1
    for i in range(steps + 1):
        t = i / steps
        x = ax + (bx - ax) * t
        z = az + (bz - az) * t
        for cx in (math.floor(x - BOT_HALF_WIDTH), math.floor(x + BOT_HALF_WIDTH)):
            for cz in (math.floor(z - BOT_HALF_WIDTH), math.floor(z + BOT_HALF_WIDTH)):
                x0, z0 = int(origin[0]), int(origin[1])
                i, j = cz - z0, cx - x0
                if not (0 <= i < len(rows) and 0 <= j < len(rows[0])):
                    continue
                if rows[i][j] != ".":
                    return False
    return True


def _center(cell):
    return (cell[0] + 0.5, cell[1] + 0.5)


def smooth_path(rows, origin, path):
    """Greedy string-pull over cell centres: keep only waypoints the direct
    segment can reach. Returns centre coordinates the bot actually steers to."""
    if len(path) <= 1:
        return [_center(cell) for cell in path]
    result = []
    current = _center(path[0])
    i = 1
    while i < len(path):
        j = len(path) - 1
        while j > i and not _line_clear(rows, origin, current, _center(path[j])):
            j -= 1
        current = _center(path[j])
        result.append(current)
        i = j + 1
    return result


def find_path(rows, origin, start, goal):
    """Waypoint cells (world ints, start excluded) from `start` to `goal`, or
    None when either end is blocked or no route exists. Diagonals never cut
    corners: both orthogonal cells must be clear."""
    sx, sz = start
    tx, tz = goal
    if not (_passable(rows, origin, sx, sz) and _passable(rows, origin, tx, tz)):
        return None
    if start == goal:
        return []
    x0, z0 = origin

    def heuristic(x, z):
        dx, dz = abs(x - tx), abs(z - tz)
        return max(dx, dz) + 0.42 * min(dx, dz)

    open_heap = [(0.0, start)]
    came = {start: None}
    costs = {start: 0.0}
    while open_heap:
        _, current = heapq.heappop(open_heap)
        if current == goal:
            path = []
            node = current
            while node is not None and node != start:
                path.append(node)
                node = came[node]
            path.reverse()
            return [(x, z) for x, z in smooth_path(rows, origin, path)]
        cx, cz = current
        for dx, dz, cost in _STEPS:
            nx, nz = cx + dx, cz + dz
            if not _passable(rows, origin, nx, nz):
                continue
            if dx and dz and not (_passable(rows, origin, cx + dx, cz)
                                  and _passable(rows, origin, cx, cz + dz)):
                continue  # no corner cutting through wall tips
            next_cost = costs[current] + cost
            nxt = (nx, nz)
            if nxt not in costs or next_cost < costs[nxt]:
                costs[nxt] = next_cost
                came[nxt] = current
                heapq.heappush(open_heap, (next_cost + heuristic(nx, nz), nxt))
    return None

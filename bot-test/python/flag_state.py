"""Event-maintained flag/goal state helpers for the pyjump bots. The server
broadcasts every state change the route code cares about — pickups
("[CTF] NAME 夺取了 X 队的一面旗。"), deposits ("X 队已插旗 N/8。"), captures
(the jail broadcast implies a carrier's flag re-plants at an unannounced
spot) — so bots keep a live banner/goal table from chat instead of re-reading
the world every few hundred milliseconds. Pure helpers live here; the bots own
the caches and the scan-based reconciliation. Mirrors bot-test/flag-state.js.
"""


def take_nearest(cells, x, z):
    """Pop and return the cell nearest to (x, z) from a {key: {x, z}} dict."""
    if not cells:
        return None
    key = min(cells, key=lambda k: (cells[k]["x"] - x) ** 2 + (cells[k]["z"] - z) ** 2)
    return cells.pop(key)

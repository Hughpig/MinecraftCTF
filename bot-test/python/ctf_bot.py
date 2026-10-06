"""Python CTF bots — a port of the root ctf_bot.js onto bot-test/python/mc.py.

Runs CTF_BOTS protocol-level clients in one process (one thread each) using
the same chat protocol and environment variables as the Node bots, so the
launcher treats them like any other style. Movement is packet-level stepping
(1.6 blocks/s walk speed); the server owns all gameplay checks.
"""

import json
import logging
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mc import MinecraftClient  # noqa: E402
import ctf_steer  # noqa: E402

HOST = os.environ.get("CTF_HOST", "127.0.0.1")
PORT = int(os.environ.get("CTF_PORT", "25565"))
BOTS = max(1, min(16, int(os.environ.get("CTF_BOTS", "2"))))
PLAYERS_PER_TEAM = max(1, min(16, int(os.environ.get("CTF_PLAYERS", "3"))))
TEAM_SIDE = (os.environ.get("CTF_TEAM_SIDE") or os.environ.get("CTF_SIDE") or "").lower()
NAME_PREFIX = os.environ.get("CTF_NAME_PREFIX", "SimpleCTF")
MAP_MODE = os.environ.get("CTF_MAP_MODE", "fixed")
MATCH_EXTRA = (os.environ.get("CTF_MATCH_EXTRA") or "").strip()
ENEMY = os.environ.get("CTF_ENEMY", "bot")
SEND_SETUP = os.environ.get("CTF_SETUP", "1") != "0"

MATCH = f"match team:{NAME_PREFIX.lower()} enemy:{ENEMY} players:{PLAYERS_PER_TEAM} map:{MAP_MODE}"
if MATCH_EXTRA:
    MATCH += " " + MATCH_EXTRA
SNAPSHOT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "..", "..", "server", "plugins", "MinecraftCTF", "viewer-state.json")

CONTROL_INTERVAL = 0.1
STEP_DISTANCE = 0.5
FLAG_ROWS = [-30, -22, -14, -6]

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(name)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("py-ctf")

game_lock = threading.Lock()
stats = {"pickups": 0, "captures": 0, "gameEnded": False, "started": False, "exitCode": 0}
bots = []


class CtfBot:
    def __init__(self, index):
        self.index = index
        self.username = f"{NAME_PREFIX}_{index + 1}"
        self.client = MinecraftClient(HOST, PORT, self.username, on_chat=self.on_chat,
                                      on_end=self.on_end)
        self.team = None
        self.running = False
        self.carrying = False
        self.jailed = False
        self.stopped = False
        self.route_index = 0
        self.state_waiters = []
        self.wait_lock = threading.Lock()
        self.jail_fallback = None

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self.client.start()

    def on_end(self, reason):
        log.info("%s %s", self.username, reason)

    def notify_waiters(self):
        with self.wait_lock:
            waiters = self.state_waiters[:]
            self.state_waiters.clear()
        for event in waiters:
            event.set()

    def wait_for(self, predicate, timeout):
        deadline = time.time() + timeout
        while not self.stopped and not predicate() and time.time() < deadline:
            event = threading.Event()
            with self.wait_lock:
                self.state_waiters.append(event)
            event.wait(timeout=max(0.05, deadline - time.time()))
        return not self.stopped and predicate()

    # -- chat protocol -----------------------------------------------------

    def on_chat(self, text):
        if not text:
            return
        log.info("%s %s", self.username, text)
        if "你携带了" in text:
            self.carrying = True
            with game_lock:
                stats["pickups"] += 1
            self.notify_waiters()
            return
        if "插旗成功！" in text:
            self.carrying = False
            with game_lock:
                stats["captures"] += 1
            self.notify_waiters()
            return
        if "旗已在附近重新立起" in text:
            self.carrying = False
            self.notify_waiters()
            return
        if "你被" in text and "关入" in text:
            self.carrying = False
            self.jailed = True
            self.notify_waiters()
            self.arm_jail_fallback()
            return
        if "监狱门已打开" in text:
            self.jailed = False
            self.notify_waiters()
            return
        if "Game over!" in text:
            self.stop()
            return
        if "Are you ready?" in text:
            self.client.send_chat("I'm ready!")
            return
        marker = "Game start: "
        start = text.find(marker)
        if start < 0:
            return
        try:
            teams = json.loads(text[start + len(marker):])
        except json.JSONDecodeError:
            return
        self.team = "left" if self.username in teams.get("left", []) else \
            "right" if self.username in teams.get("right", []) else None
        if self.team:
            log.info("%s started for %s", self.username, self.team)
            threading.Thread(target=self.run, name="route-" + self.username, daemon=True).start()

    def arm_jail_fallback(self):
        def release():
            if self.jailed and not self.stopped:
                self.jailed = False
                self.notify_waiters()
                log.info("%s jail timer fallback: leaving prison", self.username)
        timer = threading.Timer(31.0, release)
        timer.daemon = True
        timer.start()

    # -- movement ------------------------------------------------------------

    def tree_cells(self):
        """Obstacle cells from the server snapshot (3x3 tree footprints)."""
        state = self._read_snapshot()
        if not state:
            return set()
        return {f"{b['x']},{b['z']}" for b in state.get("blocks", []) if b.get("kind") == "tree"}

    def move_to(self, target, tolerance=0.85, max_seconds=20.0):
        started = time.time()
        last_progress = started
        last_distance = float("inf")
        detour = None
        while not self.stopped and not self.jailed:
            position = self.client.position
            dx = target["x"] - position.x
            dz = target["z"] - position.z
            distance = (dx * dx + dz * dz) ** 0.5
            if distance <= tolerance:
                return True
            if time.time() - started > max_seconds or time.time() - last_progress > 3.0:
                return False
            # Steer around 3x3 trees (protocol bots cannot jump them): the tree
            # cells come from the server snapshot, the detour math from
            # ctf_steer — the same algorithm the mineflayer bots use.
            trees = self.tree_cells()
            if trees:
                def probe(x, z, level):
                    return f"{x},{z}" in trees
                steer = ctf_steer.plan_steer(
                    {"x": position.x, "z": position.z}, {"x": target["x"], "z": target["z"]},
                    detour, probe)
                detour = steer["detour"]
                steer_point = steer["steer_point"]
            else:
                steer_point = {"x": target["x"], "z": target["z"]}
            sdx = steer_point["x"] - position.x
            sdz = steer_point["z"] - position.z
            steer_len = max((sdx * sdx + sdz * sdz) ** 0.5, 0.01)
            step = min(STEP_DISTANCE, distance)
            position.x += sdx / steer_len * step
            position.z += sdz / steer_len * step
            self.client.send_position()
            if distance < last_distance - 0.1:
                last_distance = distance
                last_progress = time.time()
            time.sleep(CONTROL_INTERVAL)
        return False

    def in_own_prison(self):
        if not self.team:
            return False
        position = self.client.position
        side = -20 <= position.x <= -12 if self.team == "left" else 12 <= position.x <= 20
        return side and 24 <= position.z <= 32

    @staticmethod
    def _read_snapshot():
        # Local demo convenience: the server's authoritative snapshot sits on
        # the same machine, and the protocol client does not parse chunk data —
        # without it, random stand layouts leave this bot walking between empty
        # legacy coordinates.
        try:
            with open(SNAPSHOT_PATH, encoding="utf-8") as handle:
                state = json.load(handle)
            if state.get("mapBuilt") and state.get("phase") in ("running", "finished"):
                return state
        except (OSError, json.JSONDecodeError):
            pass
        return None

    def enemy_flags(self):
        state = self._read_snapshot()
        if state:
            enemy = "right" if self.team == "left" else "left"
            live = [{"x": f["x"] - 0.5, "z": f["z"] + 0.5}
                    for f in state.get("flags", [])
                    if f["team"] == enemy and f.get("status") == "available"]
            if live:
                return live
        sign = 1 if self.team == "left" else -1
        return [{"x": sign * (column - 1) - 0.5 * sign, "z": z} for column in (18, 10) for z in FLAG_ROWS]

    def home_targets(self):
        state = self._read_snapshot()
        if state:
            live = [{"x": t["x"] + 0.5, "z": t["z"] + 0.5}
                    for t in state.get("targets", [])
                    if t["team"] == self.team and not t.get("locked")]
            if live:
                return live
        sign = -1 if self.team == "left" else 1
        # Legacy goals sit at ±4/±7; aim at the gold block centre so the 1.58
        # block deposit check (including +1 for standing on it) is reachable.
        return [{"x": sign * column - 0.5 * sign, "z": z} for column in (4, 7) for z in FLAG_ROWS]

    @staticmethod
    def nearest(items, position):
        return min(items, key=lambda item: (item["x"] - position.x) ** 2 + (item["z"] - position.z) ** 2)

    # -- route ---------------------------------------------------------------

    def run(self):
        if self.running:
            return
        self.running = True
        time.sleep(2.5)
        def trace():
            while not self.stopped:
                p = self.client.position
                log.info("%s pos=(%.1f,%.1f) carrying=%s jailed=%s",
                         self.username, p.x, p.z, self.carrying, self.jailed)
                time.sleep(5)
        threading.Thread(target=trace, name="trace-" + self.username, daemon=True).start()
        side_index = int("".join(ch for ch in self.username if ch.isdigit()) or 0)
        route = self.enemy_flags()[self.index % 3::3]
        while not self.stopped:
            if self.jailed:
                time.sleep(0.5)
                continue
            if self.in_own_prison():
                self.move_to({"x": -15.5 if self.team == "left" else 16.5, "z": 23.5})
                continue
            if not self.carrying:
                flag = route[self.route_index % len(route)]
                self.route_index += 1
                if not self.move_to(flag):
                    continue
                if not self.wait_for(lambda: self.carrying, 2.5):
                    continue
                time.sleep(0.15)
                continue
            target = self.nearest(self.home_targets(), self.client.position)
            # Tight approach when aiming at a gold block centre; the snapshot
            # goals are already block-centred so 0.3 works for both paths.
            if not self.move_to(target, tolerance=0.3):
                continue
            self.wait_for(lambda: not self.carrying, 2.5)
            time.sleep(0.15)

    def join_flow(self):
        # Same cadence as ctf_bot.js: setup (first bot only), pinned side, match.
        # play_ready flips inside the reader thread without touching the CTF
        # waiter list, so poll it directly instead of wait_for.
        deadline = time.time() + 30
        while not self.client.play_ready and time.time() < deadline and not self.stopped:
            time.sleep(0.2)
        if not self.client.play_ready:
            log.warning("%s never received the play spawn", self.username)
            return
        time.sleep(0.2)
        if self.index == 0 and SEND_SETUP:
            self.client.send_chat("/ctf setup")
            time.sleep(0.7)
        if TEAM_SIDE:
            self.client.send_chat(f"/ctf join {TEAM_SIDE}")
            time.sleep(0.25)
        self.client.send_chat(MATCH)

    def heartbeat(self):
        while not self.stopped and self.client.connected:
            self.client.send_flying()
            time.sleep(1.0)

    def stop(self):
        if self.stopped:
            return
        self.stopped = True
        self.notify_waiters()
        self.client.close()


def stop_all(passed):
    with game_lock:
        if stats["exitCode"]:
            return
        stats["exitCode"] = 0 if passed else 1
    for bot in bots:
        bot.stop()
    print(f"[smoke] {'PASS' if passed else 'FAIL'}: pickups={stats['pickups']}, "
          f"captures={stats['captures']}, gameEnded={stats['gameEnded']}", flush=True)


def main():
    for index in range(BOTS):
        bot = CtfBot(index)
        bots.append(bot)
    def monitor():
        # End the process when the match ends (Game over!), every bot stopped
        # for any reason, or 210s pass. Do not judge the login phase: clients
        # only report connected once they reach the play state.
        deadline = time.time() + 210
        while time.time() < deadline:
            with game_lock:
                if stats["gameEnded"]:
                    break
            if bots and all(bot.stopped for bot in bots):
                break
            time.sleep(0.5)
        with game_lock:
            passed = stats["gameEnded"] and stats["pickups"] > 0 and stats["captures"] > 0
            stats["gameEnded"] = True
        stop_all(passed)
    threading.Thread(target=monitor, name="monitor", daemon=True).start()
    for bot in bots:
        bot.start()
        threading.Thread(target=bot.join_flow, name="join-" + bot.username, daemon=True).start()
        threading.Thread(target=bot.heartbeat, name="hb-" + bot.username, daemon=True).start()
        time.sleep(0.4)
    # Keep the process alive until the monitor decides the outcome.
    deadline = time.time() + 220
    while time.time() < deadline and bots and any(not bot.stopped for bot in bots):
        time.sleep(0.5)
    time.sleep(0.5)
    sys.exit(stats["exitCode"])


def game_over_hook():
    with game_lock:
        stats["gameEnded"] = True


# Game over handling: route threads call stop() which closes clients; the
# monitor computes PASS from the collected stats.
_original_stop = CtfBot.stop
def _stop_with_game_end(self):
    with game_lock:
        stats["gameEnded"] = True
    _original_stop(self)
CtfBot.stop = _stop_with_game_end


if __name__ == "__main__":
    main()

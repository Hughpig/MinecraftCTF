"""Python jump-smart bots — full jump_smart_bot_test.js parity, running
mineflayer through JSPyBridge (see mf.py).

One process hosts one Node bridge and CTF_BOTS mineflayer bots with real
physics: sprint-jump movement, ctf-steer detours, player dodging, home
captures, shared flag claims and plate rescues — the same chat protocol and
environment variables as the Node bots, so the launcher treats them identically.
"""

import json
import logging
import math
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from javascript import require  # noqa: E402
import ctf_coord  # noqa: E402
import ctf_steer  # noqa: E402
import flag_state as flag_state_mod  # noqa: E402
import mf  # noqa: E402
from mf import BridgeBot  # noqa: E402

HOST = os.environ.get("CTF_HOST", "127.0.0.1")
PORT = int(os.environ.get("CTF_PORT", "25565"))
BOT_COUNT = max(1, min(16, int(os.environ.get("CTF_BOTS", "6"))))
PLAYERS_PER_TEAM = max(1, min(16, int(os.environ.get("CTF_PLAYERS", "3"))))
TEAM_SIDE = (os.environ.get("CTF_TEAM_SIDE") or "").lower()
ACTIVE_TEAMS = TEAM_SIDE or os.environ.get("CTF_ACTIVE_TEAM", "both")
NAME_PREFIX = os.environ.get("CTF_NAME_PREFIX", "LocalCTF")
MAP_MODE = os.environ.get("CTF_MAP_MODE", "fixed")
MATCH_EXTRA = (os.environ.get("CTF_MATCH_EXTRA") or "").strip()
ENEMY = os.environ.get("CTF_ENEMY", "bot")
SEND_SETUP = os.environ.get("CTF_SETUP", "1") != "0"
VIEW_DISTANCE = int(os.environ.get("CTF_BOT_VIEW_DISTANCE", "3"))
MATCH = f"match team:{NAME_PREFIX.lower()} enemy:{ENEMY} players:{PLAYERS_PER_TEAM} map:{MAP_MODE}"
if MATCH_EXTRA:
    MATCH += " " + MATCH_EXTRA
FLAG_APPROACH_OFFSET = 1.25
FLAG_ROWS = [-30, -22, -14, -6]

CLAIM_LEASE_MS = 15000
JAIL_ENTRY_TIMEOUT_S = 32.0
RESCUE_LEASE_S = 25.0  # matches the plate walk + hold budget; stale epochs re-claim
FLAG_RESCAN_S = 5.0    # reconciliation safety net for missed events (e.g. a quitting carrier)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(name)s] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("mf-jump")

stopping = False
game_ended = False
stats = {"pickups": 0, "captures": 0, "route_failures": 0}
scan_stats = {"enemy_scans": 0, "goal_scans": 0}
stats_lock = threading.Lock()
confirm_map_ready = threading.Event()

# Team coordination: dynamic flag claims (short leases) and jail/rescue
# bookkeeping — shared across bot processes via the [CTFC] chat protocol and
# mirrored by the Node bots. "rescue" is the cross-process epoch of the single
# in-flight rescue; one plate press frees every prisoner, so one rescuer
# covers the whole door.
coordination = {team: {"claims": {}, "jailed": {}, "rescuers": {}, "rescue": None}
                for team in ("left", "right")}
coordination_lock = threading.RLock()

# Live banner/goal tables maintained from broadcasts, one per team per process:
# every pickup/deposit/jail broadcast mutates them, so route code consults a
# dict instead of re-reading up to 1.5k world blocks every few hundred ms.
# "dirty" forces a bounded rescan — capture drops re-plant flags at positions
# nobody announces, and a quitting carrier's drop is never broadcast at all.
flag_state = {team: {"enemy": {}, "dirty": True, "scanned_at": 0.0,
                     "last_pickup": ("", 0.0),
                     "goals": {}, "goals_dirty": True}
              for team in ("left", "right")}
flag_state_lock = threading.RLock()


def is_in_prison_cell(position):
    return bool(position) and 26 <= position.get("z", 0) <= 31 \
        and 12 <= abs(position.get("x", 0)) <= 20


class PyJumpBot:
    def __init__(self, index, mineflayer, vec3):
        self.index = index
        self.username = f"{NAME_PREFIX}_{index + 1}"
        self.team = None
        self.team_index = 0
        self.team_size = 1
        self.role = "attacker"
        self.opponents = set()
        self.teammates = set()
        self.started = False
        self.route_running = False
        self.route_failed = False
        self.carrying = False
        self.jailed = False
        self.stopped = False
        self.captures_count = 0
        self.claimed_key = None
        self.rescue_target = None
        self.rescue_stolen = False
        self.flag_scan = (0.0, [])
        self._gold_id = None
        self.state_waiters = []
        self.wait_lock = threading.Lock()
        self.bot = BridgeBot(mineflayer, vec3, HOST, PORT, self.username,
                             on_chat=self.on_chat, on_end=self.on_end,
                             view_distance=VIEW_DISTANCE)

    # -- lifecycle ---------------------------------------------------------

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
        while not stopping and not predicate() and time.time() < deadline:
            event = threading.Event()
            with self.wait_lock:
                self.state_waiters.append(event)
            event.wait(timeout=max(0.05, deadline - time.time()))
        return not stopping and predicate()

    # -- chat protocol -------------------------------------------------------

    def on_chat(self, text):
        if not text:
            return
        log.info("%s %s", self.username, text)
        self.note_jail(text)
        coord = ctf_coord.parse_coordination(text, self.username, self.teammates)
        if coord:
            self.apply_coordination(*coord)
        if "地图已生成：" in text or "地图已就绪：" in text:
            confirm_map_ready.set()
            # A rebuilt map invalidates every remembered banner/goal cell.
            with flag_state_lock:
                for state in flag_state.values():
                    state["enemy"] = {}
                    state["dirty"] = True
                    state["last_pickup"] = ("", 0.0)
                    state["goals"] = {}
                    state["goals_dirty"] = True
        if " 夺取了 " in text and "队的一面旗" in text:
            self.note_flag_pickup(text)
        if " 队已插旗 " in text:
            self.note_flag_deposit(text)
        if "Are you ready?" in text:
            self.bot.chat("I'm ready!")
        if text.startswith("Game start: "):
            self.on_game_start(text[len("Game start: "):])
        if "你携带了" in text:
            self.carrying = True
            with stats_lock:
                stats["pickups"] += 1
            self.notify_waiters()
        if "插旗成功！" in text:
            self.carrying = False
            self.captures_count += 1
            with stats_lock:
                stats["captures"] += 1
            self.notify_waiters()
        if "旗已在附近重新立起" in text:
            self.carrying = False
            # Our carried flag re-planted at an unannounced nearby cell.
            if self.team:
                with flag_state_lock:
                    flag_state[self.team]["dirty"] = True
            self.notify_waiters()
        if (f"{self.username} 被抓捕并关入" in text) or ("你被 " in text and "抓捕，监禁" in text):
            self.carrying = False
            self.jailed = True
            self.notify_waiters()
        if "监禁结束" in text or "已获释" in text or "监狱门已打开" in text:
            self.jailed = False
            # The door opens for the whole team at once and this release is
            # invisible to other processes — tell them to drop their jail and
            # rescue bookkeeping (a timer release has no rescuer to say it).
            self.coord_chat(ctf_coord.freed_message())
            self.notify_waiters()
        if "Game over!" in text and self.started:
            with stats_lock:
                stats["game_ended"] = True
            stop_all()
        if "Game over!" in text and not self.started:
            with stats_lock:
                stats["game_ended"] = True

    def note_jail(self, message):
        if not self.team or " 被抓捕并关入 " not in message:
            return
        who = message.split(" 被抓捕并关入")[0].replace("[CTF] ", "").strip()
        with coordination_lock:
            if who not in self.teammates:
                return
            c = coordination[self.team]
            c["jailed"][who] = time.time()
            for key in [k for k, claim in c["claims"].items() if claim["by"] == who]:
                c["claims"].pop(key, None)
            # A jailed rescuer cannot reach the plate: their epoch is dead and
            # someone else must be able to claim the rescue.
            if c.get("rescue") and c["rescue"]["by"] == who:
                c["rescue"] = None
            # If they were carrying, their flag re-planted at an unannounced
            # spot: the banner table needs a fresh scan.
            with flag_state_lock:
                flag_state[self.team]["dirty"] = True

    # -- [CTFC] team chat -----------------------------------------------------

    def coord_chat(self, message):
        try:
            self.bot.chat(f"{ctf_coord.CHAT_PREFIX} {message}")
        except Exception:
            pass

    def _rescue_taken_over(self, c):
        return self.rescue_stolen or bool(c.get("rescue") and c["rescue"]["by"] != self.username)

    def apply_coordination(self, sender, command, arg):
        """Mirror a teammate's [CTFC] line into the shared coordination state."""
        if not self.team:
            return
        with coordination_lock:
            c = coordination[self.team]
            now = time.time()
            if command == "c":
                if arg not in c["claims"]:
                    c["claims"][arg] = {"by": sender, "at": now}
            elif command == "u":
                claim = c["claims"].get(arg)
                if claim and claim["by"] == sender:
                    c["claims"].pop(arg, None)
            elif command == "r":
                if self.rescue_target and self.username < sender:
                    return  # both claimed at once: the smaller name keeps it
                if self.rescue_target:
                    # A teammate with priority took the door over; drop this
                    # walk instead of double-pressing the plate.
                    self.rescue_stolen = True
                    log.info("%s rescue of %s taken over by %s", self.username, self.rescue_target, sender)
                c["rescue"] = {"by": sender, "at": now}
            elif command == "f":
                c["jailed"].clear()
                c["rescue"] = None

    # -- broadcast-driven banner/goal state ----------------------------------

    def note_flag_pickup(self, message):
        """'[CTF] NAME 夺取了 右 队的一面旗。' — only our own team can pick the
        banners we attack, and the picker stands on the cell at pickup time."""
        if not self.team:
            return
        if " 夺取了 右 队的一面旗" in message:
            owner = "right"
        elif " 夺取了 左 队的一面旗" in message:
            owner = "left"
        else:
            return
        if owner == self.team:
            return  # an enemy took one of OUR flags; their banners are untouched
        who = message.split(" 夺取了")[0].replace("[CTF] ", "").strip()
        if who != self.username and who not in self.teammates:
            return
        with flag_state_lock:
            state = flag_state[self.team]
            now = time.time()
            if state["last_pickup"][0] == who and now - state["last_pickup"][1] < 2.0:
                return  # a process-mate's chat handler already applied this one
            state["last_pickup"] = (who, now)
            at = self.position() if who == self.username else self.bot.entity_position(who)
            if at:
                flag_state_mod.take_nearest(state["enemy"], at["x"], at["z"])
            else:
                state["dirty"] = True  # picker out of view: rescan to find the gap

    def note_flag_deposit(self, message):
        """'[CTF] 左 队已插旗 N/8。' — the deposit locks a goal cell but the
        broadcast carries no position, so the next goal consumer rescans."""
        if not self.team:
            return
        if f"{'左' if self.team == 'left' else '右'} 队已插旗 " in message:
            with flag_state_lock:
                flag_state[self.team]["goals_dirty"] = True

    def refresh_enemy_flags(self):
        """Live enemy banner cells: broadcast-maintained, reconciled by a
        bounded scan at most every FLAG_RESCAN_S or when a drop marked it dirty."""
        if not self.team:
            return []
        with flag_state_lock:
            state = flag_state[self.team]
            now = time.time()
            if state["dirty"] or now - state["scanned_at"] > FLAG_RESCAN_S:
                positions = self.scan_enemy_banners()
                state["enemy"] = {ctf_coord.claim_key(p["x"], p["z"]): {"x": p["x"], "z": p["z"]}
                                  for p in positions}
                state["dirty"] = False
                state["scanned_at"] = now
            return list(state["enemy"].values())

    def on_game_start(self, payload):
        try:
            teams = json.loads(payload)
        except json.JSONDecodeError:
            log.info("%s cannot parse game start", self.username)
            return
        self.team = "left" if self.username in teams.get("left", []) else \
            "right" if self.username in teams.get("right", []) else None
        if not self.team:
            return
        self.team_index = teams[self.team].index(self.username)
        self.team_size = len(teams[self.team])
        self.role = "defender" if self.team_index == 0 else "attacker"
        self.opponents = set(teams["left" if self.team == "right" else "right"])
        self.teammates = set(teams[self.team]) - {self.username}
        self._gold_id = None
        if self.started:
            return
        self.started = True
        if ACTIVE_TEAMS in ("both", self.team):
            def run():
                try:
                    self.run_smart_route()
                except Exception as error:
                    self.route_failed = True
                    self.bot.clear_controls()
                    log.info("%s route error; recovery: %s", self.username, error)
                    self.recover_route()
            threading.Thread(target=run, name="route-" + self.username, daemon=True).start()
        log.info("%s jump-smart role=%s teamIndex=%d", self.username, self.role, self.team_index)

    # -- world helpers -------------------------------------------------------

    def home_sign(self):
        return -1 if self.team == "left" else 1

    def is_home_half(self, position):
        return bool(position) and position.get("x", 0) * self.home_sign() > 1

    def position(self):
        return self.bot.read_position()

    def nearest_opponent(self, position, max_distance=3.5):
        best = None
        best_distance = max_distance
        for username in list(self.opponents):
            ep = self.bot.entity_position(username)
            if not ep or abs(ep.get("y", 64) - position.get("y", 64)) > 2.5:
                continue
            distance = math.hypot(ep["x"] - position["x"], ep["z"] - position["z"])
            if distance < best_distance:
                best = {"username": username, "x": ep["x"], "z": ep["z"]}
                best_distance = distance
        return best

    def nearest_home_opponent(self, max_distance=96):
        if not self.team:
            return None
        own = self.position()
        best = None
        best_distance = max_distance
        for username in list(self.opponents):
            ep = self.bot.entity_position(username)
            if not ep or not self.is_home_half(ep):
                continue
            distance = math.hypot(ep["x"] - own["x"], ep["z"] - own["z"])
            if distance < best_distance and abs(ep.get("y", 64) - own.get("y", 64)) <= 2.5:
                best = {"username": username, "x": ep["x"], "z": ep["z"]}
                best_distance = distance
        return best

    def entity_by_name(self, username):
        return self.bot.entity_position(username)

    # -- movement ------------------------------------------------------------

    def go_near(self, x, z, completed=None, options=None):
        options = options or {}
        completed = completed or (lambda: False)
        self.bot.clear_controls()
        started = time.time()
        max_duration = options.get("maxDuration", 20.0)
        dodge_players = options.get("dodgePlayers", True)
        no_detour = options.get("noDetour", False)
        target = {"x": x, "z": z}
        last_x = last_z = None
        last_progress = time.time()
        nudge_until = 0.0
        nudge_left = False
        dodge_until = 0.0
        dodge_left = False
        dodging_opponent = ""
        detour = None
        stall_count = 0
        unstick_until = 0.0
        unstick_point = None
        was_jailed = False
        while not stopping and time.time() - started < max_duration:
            if completed():
                self.bot.clear_controls()
                return True
            if self.jailed:
                was_jailed = True
                self.bot.clear_controls()
                time.sleep(0.25)
                started = time.time()
                continue
            if was_jailed:
                # Released while this leg was running: abort so the route
                # re-runs leave_prison instead of grinding at the cell bars.
                self.bot.clear_controls()
                raise RuntimeError("released from prison mid-leg")
            position = self.position()
            dx = target["x"] - position["x"]
            dz = target["z"] - position["z"]
            distance = math.hypot(dx, dz)
            if distance <= 0.35 and abs(position["y"] - 64) < 2.0:
                self.bot.clear_controls()
                return True
            if no_detour:
                detour = None
            if last_x is None or math.hypot(position["x"] - last_x, position["z"] - last_z) > 0.12:
                last_x, last_z = position["x"], position["z"]
                last_progress = time.time()
                stall_count = 0
            elif time.time() - last_progress > 1.2 and nudge_until < time.time():
                stall_count += 1
                nudge_left = not nudge_left
                nudge_until = time.time() + 0.55
                last_progress = time.time()
                # Wedged in a corner between clusters: back out, then re-plan.
                if stall_count >= 2 and unstick_until < time.time():
                    steer_len = max(distance, 0.01)
                    unstick_point = {"x": position["x"] - dx / steer_len * 1.6,
                                     "z": position["z"] - dz / steer_len * 1.6}
                    unstick_until = time.time() + 1.2
                    detour = None
                    stall_count = 0
            if unstick_until > time.time() and unstick_point:
                steer_point = unstick_point
            else:
                result = ctf_steer.plan_steer(position, target, detour, self.bot.probe)
                detour = result["detour"]
                steer_point = result["steer_point"]
            steer_dx = steer_point["x"] - position["x"]
            steer_dz = steer_point["z"] - position["z"]
            steer_distance = max(math.hypot(steer_dx, steer_dz), 0.01)
            # While carrying or deep in the enemy half the bot flees jailers
            # from further away and commits to the sidestep longer.
            fleeing = self.carrying or not self.is_home_half(position)
            opponent = self.nearest_opponent(position, 4.5 if fleeing else 3.5) if dodge_players else None
            if opponent and (opponent["username"] != dodging_opponent or dodge_until <= time.time()):
                dodging_opponent = opponent["username"]
                away = {"x": position["x"] - opponent["x"], "z": position["z"] - opponent["z"]}
                away_len = max(math.hypot(away["x"], away["z"]), 0.01)
                side = ctf_steer.strafe_side_for_away(
                    {"x": steer_dx / steer_distance, "z": steer_dz / steer_distance},
                    {"x": away["x"] / away_len, "z": away["z"] / away_len})
                dodge_left = (side == "left") if side else \
                    (math.floor(position["x"] * 10) + math.floor(position["z"] * 10) + len(dodging_opponent)) % 2 == 0
                dodge_until = time.time() + (0.7 if fleeing else 0.55)
            self.bot.look_at(steer_point["x"], position["y"] + 1.62, steer_point["z"])
            self.bot.control("forward", True)
            # Sprint-jump is the fastest ground movement; walk the final approach.
            self.bot.control("sprint", distance > 2.0)
            dodging = dodge_until > time.time()
            self.bot.control("left", dodge_left if dodging else (nudge_left and nudge_until > time.time()))
            self.bot.control("right", (not dodge_left) if dodging else ((not nudge_left) and nudge_until > time.time()))
            self.bot.control("jump", distance > 1.6)
            time.sleep(0.1)
        self.bot.clear_controls()
        if stopping:
            return False
        raise RuntimeError(f"cannot reach {x},{z}")

    def wait_for_release(self):
        if not self.wait_for(lambda: not self.jailed, 35):
            raise RuntimeError("jail release was not confirmed")

    def leave_prison(self):
        position = self.position()
        if not (26 <= position["z"] <= 31 and 12 <= abs(position["x"]) <= 20):
            return
        door_x = -15.5 if self.team == "left" else 16.5
        # Never detour or dodge inside the ring; push along the doorway axis.
        for _ in range(6):
            if stopping:
                return
            self.go_near(door_x, 26.4, options={"noDetour": True, "dodgePlayers": False, "maxDuration": 9})
            try:
                self.go_near(door_x, 23.5, options={"noDetour": True, "dodgePlayers": False, "maxDuration": 15})
                return
            except RuntimeError:
                self.bot.clear_controls()

    # -- flags / claims ------------------------------------------------------

    def scan_enemy_banners(self):
        with stats_lock:
            scan_stats["enemy_scans"] += 1
        return self.bot.scan_enemy_banners(self.team)

    def is_banner_gone(self, cell):
        # Event-driven: pickup broadcasts remove banners from the live table,
        # so this is a dict lookup instead of a block read every physics tick.
        if not self.team:
            return False
        with flag_state_lock:
            state = flag_state[self.team]
            if state["scanned_at"] == 0.0 or state["dirty"]:
                return False  # table unknown or reconciling; the pickup wait decides
            return ctf_coord.claim_key(cell["x"], cell["z"]) not in state["enemy"]

    def prune_claims(self):
        with coordination_lock:
            c = coordination[self.team]
            now = time.time()
            for key in list(c["claims"].keys()):
                claim = c["claims"][key]
                if (now - claim["at"]) * 1000 > CLAIM_LEASE_MS or c["jailed"].get(claim["by"]):
                    c["claims"].pop(key, None)

    def claim_enemy_flag(self, positions):
        own = self.position()
        with coordination_lock:
            self.prune_claims()
            c = coordination[self.team]
            sorted_positions = sorted(
                positions, key=lambda p: (p["x"] - own["x"]) ** 2 + (p["z"] - own["z"]) ** 2)
            chosen = None
            for p in sorted_positions:
                key = ctf_coord.claim_key(p["x"], p["z"])
                if key not in c["claims"]:
                    c["claims"][key] = {"by": self.username, "at": time.time()}
                    chosen = p
                    break
            if not chosen:
                chosen = sorted_positions[0]
            self.claimed_key = ctf_coord.claim_key(chosen["x"], chosen["z"])
        # Cross-process share: teammates hear the claim and pick other banners
        # until this lease expires.
        self.coord_chat(ctf_coord.claim_message(self.claimed_key))
        return chosen

    def release_claim(self):
        if not self.claimed_key:
            return
        key = self.claimed_key
        self.claimed_key = None
        with coordination_lock:
            c = coordination.get(self.team, {})
            claim = c["claims"].get(key)
            if claim and claim["by"] == self.username:
                c["claims"].pop(key, None)
                released = True
            else:
                released = False
        if released:
            self.coord_chat(ctf_coord.unclaim_message(key))

    def wait_for_enemy_banner(self):
        started = time.time()
        walked = False
        while not stopping and time.time() - started < 15:
            positions = self.refresh_enemy_flags()
            if positions:
                return positions
            # Late in a match the surviving banners can sit beyond the loaded
            # chunks; walk toward the enemy half until one scrolls into view.
            if not walked:
                walked = True
                self.go_near(-self.home_sign() * 6, self.position()["z"],
                             completed=lambda: bool(self.refresh_enemy_flags()),
                             options={"maxDuration": 7})
            time.sleep(0.15)
        raise RuntimeError("no enemy banner available")

    # -- goals ---------------------------------------------------------------

    def door_open(self):
        """Own prison door state: an open door lets the teammate walk out."""
        door_x = -16 if self.team == "left" else 16
        try:
            block = self.bot.bot.blockAt(self.bot.vec3(door_x, 64, 26))
            if block is None:
                return False
            # prismarine-block exposes states only through getProperties();
            # there is no `properties` field, so the old read always saw None
            # and rescuers stood out the whole 20s hold after the door opened.
            properties = block.getProperties()
            open_state = properties.open if properties else None
            return open_state is True or open_state == "true"
        except Exception:
            return False

    def is_goal_locked(self, goal):
        return self.bot.block_is_air(goal["x"], 64, goal["z"]) is False

    def scan_home_goals(self):
        # Bounded Node-side scan (~2ms): own-half gold blocks with air above.
        # findBlocks here used to freeze the physics loop ~500ms per carrier.
        with stats_lock:
            scan_stats["goal_scans"] += 1
        try:
            # NB: pass the mineflayer proxy (self.bot.bot), not the Python
            # wrapper — Node calls bot.world.* natively on it during the scan.
            return [{"x": float(p.x), "z": float(p.z)}
                    for p in self.bot.scans.goals(self.bot.bot, self.team)]
        except Exception:
            log.exception("goal scan failed")
            return []

    def refresh_home_goals(self):
        """Nearest unlocked home goal from the broadcast-maintained table;
        deposits mark it dirty and the next carrier rescans (goals never
        change on their own, so no staleness guard is needed)."""
        if not self.team:
            return None
        own = self.position()
        with flag_state_lock:
            state = flag_state[self.team]
            if state["goals_dirty"]:
                goals = self.scan_home_goals()
                state["goals"] = {ctf_coord.claim_key(g["x"], g["z"]): {"x": g["x"], "z": g["z"]}
                                  for g in goals}
                state["goals_dirty"] = False
            best = None
            best_distance = None
            for cell in state["goals"].values():
                distance = (cell["x"] - own["x"]) ** 2 + (cell["z"] - own["z"]) ** 2
                if best_distance is None or distance < best_distance:
                    best = dict(cell)
                    best_distance = distance
            return best

    def wait_for_home_goal(self):
        started = time.time()
        walked = False
        while not stopping and time.time() - started < 20:
            goal = self.refresh_home_goals()
            if goal:
                return goal
            if not walked:
                walked = True
                self.go_near(self.home_sign() * 2, self.position()["z"],
                             completed=lambda: self.refresh_home_goals(),
                             options={"maxDuration": 8})
            time.sleep(0.1)
        raise RuntimeError("cannot find an unlocked home goal")

    # -- rescue ---------------------------------------------------------------

    def maybe_claim_rescue(self):
        if self.carrying or self.jailed or self.rescue_target or not self.team:
            return False
        with coordination_lock:
            c = coordination[self.team]
            if not c["jailed"]:
                return False
            now = time.time()
            for name in list(c["jailed"].keys()):
                ent = self.entity_by_name(name)
                if (ent and not is_in_prison_cell(ent)) or now - c["jailed"][name] > JAIL_ENTRY_TIMEOUT_S:
                    c["jailed"].pop(name, None)
            rescue = c.get("rescue")
            if rescue:
                fresh = now - rescue["at"] < RESCUE_LEASE_S
                alive = fresh and not c["jailed"].get(rescue["by"])
                if not alive:
                    c["rescue"] = None
                elif rescue["by"] != self.username:
                    return False  # a teammate process is already handling the door
            for jailed in c["jailed"]:
                if jailed in c["rescuers"]:
                    continue
                c["rescuers"][jailed] = self.username
                self.rescue_target = jailed
                c["rescue"] = {"by": self.username, "at": now}
                claimed = jailed
                break
            else:
                return False
        self.coord_chat(ctf_coord.rescue_message(claimed))
        return True

    def rescue_teammate(self):
        c = coordination[self.team]
        target = self.rescue_target
        plate = {"x": -15.5 if self.team == "left" else 16.5, "z": 24.5}
        self.rescue_stolen = False
        log.info("%s rescuing %s: heading for the release plate", self.username, target)
        try:
            def arrived():
                if self._rescue_taken_over(c) or not c["jailed"].get(target):
                    return True
                ent = self.entity_by_name(target)
                return (ent and not is_in_prison_cell(ent)) or self.jailed
            self.go_near(plate["x"], plate["z"], completed=arrived, options={"maxDuration": 25})
            # Hold the plate until the door opens, then LEAVE immediately —
            # the freed teammate walks out through the open door themselves,
            # and lingering here just blocks the doorway.
            deadline = time.time() + 20
            while not stopping and not self.jailed and time.time() < deadline:
                door = self.door_open()
                with coordination_lock:
                    if door:
                        # One plate press frees every prisoner of the team.
                        c["jailed"].clear()
                        if c.get("rescue") and c["rescue"]["by"] == self.username:
                            c["rescue"] = None
                    superseded = self._rescue_taken_over(c)
                    already_freed = not c["jailed"].get(target) and not door
                if door:
                    self.coord_chat(ctf_coord.freed_message())
                    break
                if superseded or already_freed:
                    break
                time.sleep(0.2)
            log.info("%s rescue finished for %s", self.username, target)
        finally:
            with coordination_lock:
                if target:
                    c["rescuers"].pop(target, None)
                if c.get("rescue") and c["rescue"]["by"] == self.username:
                    c["rescue"] = None
            self.rescue_target = None

    # -- combat / patrol -------------------------------------------------------

    def chase_home_opponent(self, options=None):
        options = options or {}
        chase_deadline = time.time() + options.get("maxMs", 1e9) / 1000.0
        last_target = ""
        while not stopping and not self.jailed and time.time() < chase_deadline:
            opponent = self.nearest_home_opponent()
            if not opponent:
                return
            if opponent["username"] != last_target:
                last_target = opponent["username"]
                log.info("%s defend chase %s", self.username, last_target)
            try:
                def completed():
                    current = self.bot.entity_position(last_target)
                    return current is None or not self.is_home_half(current) or self.jailed
                self.go_near(opponent["x"], opponent["z"],
                             completed=completed,
                             options={"dodgePlayers": False, "maxDuration": 3})
            except RuntimeError:
                self.bot.clear_controls()
                time.sleep(0.1)

    def patrol_after_route(self):
        sign = self.home_sign()
        waypoints = [(sign * 2, -30), (sign * 2, -6), (sign * 8, -6), (sign * 8, -30)]
        index = 0
        while not stopping:
            self.wait_for_release()
            self.leave_prison()
            if self.maybe_claim_rescue():
                self.rescue_teammate()
                continue
            x, z = waypoints[index % len(waypoints)]
            index += 1
            free = ctf_steer.nearest_free_cell(self.bot.probe, x, z)
            self.go_near(free["x"], free["z"], completed=lambda: bool(self.nearest_home_opponent()))
            if self.nearest_home_opponent():
                self.chase_home_opponent()

    def run_defender_route(self):
        sign = self.home_sign()
        waypoints = [(sign * 8, -30), (sign * 8, -6), (sign * 3, -6), (sign * 3, -30)]
        index = 0
        while not stopping:
            self.wait_for_release()
            self.leave_prison()
            if self.maybe_claim_rescue():
                self.rescue_teammate()
                continue
            x, z = waypoints[index % len(waypoints)]
            index += 1
            free = ctf_steer.nearest_free_cell(self.bot.probe, x, z)
            self.go_near(free["x"], free["z"], completed=lambda: bool(self.nearest_home_opponent()))
            if self.nearest_home_opponent():
                self.chase_home_opponent()

    def recover_route(self):
        if stopping:
            return
        try:
            self.wait_for_release()
            self.leave_prison()
            sign = self.home_sign()
            current_z = self.position()["z"]
            recovery_points = [(sign * 2, max(-30, min(30, current_z))), (sign * 2, -30),
                               (sign * 2, -6), (sign * 4, -30), (sign * 4, -6)]
            for x, z in recovery_points:
                if stopping or not self.bot.connected or self.is_home_half(self.position()):
                    break
                try:
                    self.go_near(x, z, options={"maxDuration": 7})
                except RuntimeError:
                    self.bot.clear_controls()
            if not stopping:
                self.patrol_after_route()
        except Exception as error:
            self.bot.clear_controls()
            log.info("%s recovery error: %s", self.username, error)

    def run_attacker_route(self):
        if self.route_running:
            return
        self.route_running = True
        sign = self.home_sign()
        # No static flag routes: every claim is taken live from the shared
        # claim table, so two attackers never chase the same banner.
        while not stopping:
            captured = False
            attempts = 0
            while not stopping and not captured and attempts < 4:
                attempts += 1
                try:
                    self.wait_for_release()
                    self.leave_prison()
                    if self.maybe_claim_rescue():
                        self.rescue_teammate()
                        continue
                    if not self.carrying and self.nearest_home_opponent(6):
                        log.info("%s opportunistic chase at home", self.username)
                        self.chase_home_opponent({"maxMs": 6000})
                    positions = self.wait_for_enemy_banner()
                    chosen = self.claim_enemy_flag(positions)
                    flag = {"x": chosen["x"] + sign * FLAG_APPROACH_OFFSET, "z": chosen["z"] + 0.3,
                            "bx": chosen["x"], "bz": chosen["z"]}
                    log.info("%s go flag %.1f,%.1f (claimed)", self.username, flag["x"], flag["z"])
                    self.go_near(sign * 2, self.position()["z"])
                    self.go_near(sign * 2, flag["z"])
                    flag_target = {"x": flag["bx"], "z": flag["bz"]}
                    self.go_near(flag["x"], flag["z"],
                                 completed=lambda: self.carrying or self.is_banner_gone(flag_target))
                    # The banner can vanish between arrival and the server's
                    # pickup confirm; poll with a live gone-check.
                    if not self.wait_for(lambda: self.carrying or self.is_banner_gone(flag_target), 15):
                        raise RuntimeError("stopping during pickup")
                    if not self.carrying:
                        raise RuntimeError("flag vanished before pickup")
                    self.release_claim()
                    if stopping:
                        break
                    goal = self.wait_for_home_goal()
                    log.info("%s go goal %d,%d", self.username, goal["x"], goal["z"])
                    previous_captures = self.captures_count
                    goal_target = dict(goal)
                    self.go_near(goal["x"] + sign * 0.3, goal["z"] + 0.3,
                                 completed=lambda: self.captures_count > previous_captures
                                 or not self.carrying or self.is_goal_locked(goal_target))
                    captured = self.captures_count > previous_captures
                    if not captured and not stopping:
                        log.info("%s flag lost after capture; retrying after release", self.username)
                except RuntimeError as error:
                    self.release_claim()
                    if stopping:
                        break
                    self.bot.clear_controls()
                    if self.carrying:
                        try:
                            goal = self.wait_for_home_goal()
                            self.go_near(goal["x"] + sign * 0.3, goal["z"] + 0.3,
                                         completed=lambda: not self.carrying, options={"maxDuration": 10})
                        except RuntimeError:
                            self.bot.clear_controls()
                    log.info("%s route attempt %d/4 failed: %s", self.username, attempts, error)
                    time.sleep(0.25)
            if not stopping and not captured:
                log.info("%s round done; rescanning for the next claim", self.username)

    def run_smart_route(self):
        log.info("%s py-jump role=%s", self.username, self.role)
        if self.role == "defender":
            self.run_defender_route()
        else:
            self.run_attacker_route()


bots = []


def stop_all():
    global stopping
    if stopping:
        return
    stopping = True
    with stats_lock:
        passed = stats.get("game_ended", False) and stats["pickups"] > 0 and stats["captures"] > 0
        failures = sum(1 for bot in bots if bot.route_failed)
    process_passed = passed
    # The launcher/viewer extract lines containing "[smoke]" — keep the format.
    print(f"[smoke] {'PASS' if process_passed else 'FAIL'}: pickups={stats['pickups']}, "
          f"captures={stats['captures']}, routeFailures={failures}, gameEnded={bool(stats.get('game_ended'))}",
          flush=True)
    print(f"[smoke] scans: enemyScans={scan_stats['enemy_scans']}, "
          f"goalScans={scan_stats['goal_scans']}, blockReads={mf.BLOCK_READ_STATS['count']}", flush=True)
    global exit_code
    exit_code = 0 if process_passed else 1
    for bot in bots:
        bot.stopped = True
        bot.notify_waiters()
        bot.bot.quit("local CTF smoke test finished")


def main():
    mineflayer = require("mineflayer")
    vec3 = require("vec3")
    startup_deadline = threading.Timer(120, lambda: stop_all())
    startup_deadline.daemon = True
    startup_deadline.start()

    def monitor():
        # End the process on Game over!, every bot stopped, or the deadline.
        deadline = time.time() + 215
        while time.time() < deadline:
            with stats_lock:
                if stats.get("game_ended"):
                    break
            if bots and all(bot.stopped for bot in bots):
                break
            time.sleep(0.5)
        stop_all()

    threading.Thread(target=monitor, name="monitor", daemon=True).start()
    for index in range(BOT_COUNT):
        bot = PyJumpBot(index, mineflayer, vec3)
        bots.append(bot)
        time.sleep(0.4)
    # Wait for everyone to spawn before the match flow.
    deadline = time.time() + 30
    while time.time() < deadline and not all(bot.bot.spawned for bot in bots):
        time.sleep(0.2)
    for bot in bots:
        bot.wait_for(lambda b=bot: b.bot.spawned, 30)
    log.info("all bots spawned; starting match flow")
    if SEND_SETUP:
        bots[0].bot.chat("/ctf setup")
        confirm_map_ready.wait(timeout=60)
    if TEAM_SIDE:
        for bot in bots:
            if stopping:
                return
            bot.bot.chat(f"/ctf join {TEAM_SIDE}")
            time.sleep(0.15)
    for bot in bots:
        if stopping:
            return
        bot.bot.chat(MATCH)
        time.sleep(0.1)
    # Keep the process alive until stop_all exits.
    deadline = time.time() + 260
    while time.time() < deadline and not stopping:
        time.sleep(0.5)
    time.sleep(0.5)


if __name__ == "__main__":
    exit_code = 0
    main()
    sys.exit(exit_code)

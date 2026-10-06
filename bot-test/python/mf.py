"""mineflayer-over-JSPyBridge client wrapper for the Python CTF bots.

One Python process hosts one Node bridge (pythonia) and creates CTF_BOTS
mineflayer bots inside it — full mineflayer physics/entities/world access with
Python logic on top. Cross-bridge calls cost ~0.1-0.9 ms, so this wrapper
keeps every hot-path value in Python caches:

- self-position: read from bot.entity on demand (3 short IPC reads per tick)
- tracked players: username -> entity proxy map from entitySpawn/entityGone;
  positions are read straight from the proxy when someone asks (no event spam)
- block probes: (x, z, level) -> solid bool, TTL cache (open doors passable)
- banner scans: bot.findBlocks runs Node-side in ONE bridge call
"""

import logging
import os
import threading
import time

from javascript import require

log = logging.getLogger("mf")

DOOR_SUFFIX = "_door"

# Diagnostic counter: every block_is_air read (banner-gone checks, goal locks).
BLOCK_READ_STATS = {"count": 0}

# Node-side bounded scans (each one bridge call, ~2ms instead of findBlocks'
# 500ms full-radius search that froze the physics loop mid-run).
_NODE_SCANS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARENA_SCANS = require(os.path.join(_NODE_SCANS_DIR, "arena-scan-bridge.js"))


def safe(fn):
    """Bridge event callbacks must never raise — an unhandled Python exception
    crashes the whole Node bridge process."""

    def wrapper(*args):
        try:
            return fn(*args)
        except Exception:
            log.exception("bridge callback error")
    return wrapper


class BridgeBot:
    def __init__(self, mineflayer, vec3, host, port, username, on_chat=None, on_end=None,
                 view_distance=3):
        self.username = username
        self.on_chat = on_chat or (lambda text: None)
        self.on_end = on_end or (lambda reason: None)
        self.vec3 = vec3
        self.position = {"x": 0.0, "y": 0.0, "z": 0.0}
        self.spawned = False
        self.play_ready = False
        self.connected = False
        # Player entities are read directly from bot.players (mineflayer keeps
        # it per-username); entitySpawn events never deliver OTHER players
        # through the bridge, so event-based tracking was always empty.
        self._scan_cache = (0.0, [])          # banner scan (at, positions)
        self.scans = ARENA_SCANS
        self._probe_cache = {}                # (x, z, level) -> (solid, at)
        self._registry_id = None
        self._lock = threading.Lock()
        self.bot = mineflayer.createBot({
            "host": host, "port": port, "username": username, "auth": "offline",
            "version": "1.21.8", "viewDistance": view_distance,
        })
        bot = self.bot
        bot.once("spawn", safe(lambda *a: self._on_spawn()))
        bot.on("messagestr", safe(lambda *a: self.on_chat(str(a[0]) if a else "")))
        bot.on("kicked", safe(lambda *a: log.info("[%s] kicked: %s", username, a)))
        bot.on("error", safe(lambda *a: log.info("[%s] error: %s", username, a)))
        bot.on("end", safe(lambda *a: self._on_end(a)))

    # -- lifecycle ---------------------------------------------------------

    def _on_spawn(self):
        self.spawned = True
        self.connected = True
        try:
            self._refresh_position()
        except Exception:
            log.exception("position read failed on spawn")

    def _on_end(self, args):
        self.connected = False
        self.on_end(str(args[0]) if args else "disconnected")

    def quit(self, reason):
        try:
            self.bot.quit(reason)
        except Exception:
            log.exception("quit failed")

    # -- world / state reads -------------------------------------------------

    def _refresh_position(self):
        position = self.bot.entity.position
        self.position = {"x": float(position.x), "y": float(position.y), "z": float(position.z)}

    def read_position(self):
        self._refresh_position()
        return dict(self.position)

    def entity_position(self, username):
        """Live read: a player's position from bot.players, or None when the
        player is out of range/not spawned."""
        try:
            entity = self.bot.players[username].entity
            if not entity:
                return None
            position = entity.position
            return {"x": float(position.x), "z": float(position.z), "y": float(position.y)}
        except Exception:
            return None

    def probe(self, x, z, level):
        """Solid-for-movement check with a short TTL cache. Open doors report a
        block bounding box but do not collide, so they stay passable."""
        key = (x, z, level)
        hit = self._probe_cache.get(key)
        now = time.time()
        if hit and now - hit[1] < 0.25:
            return hit[0]
        solid = False
        block = self.bot.blockAt(self.vec3(x, 64 + level, z))
        if block is not None:
            bounding = str(block.boundingBox)
            if bounding == "block":
                solid = True
                name = str(block.name)
                if name.endswith(DOOR_SUFFIX):
                    # prismarine-block exposes states only through
                    # getProperties(); `block.properties` does not exist, so
                    # open doors used to stay "solid" here.
                    properties = self._block_properties(block)
                    open_state = properties.open if properties else None
                    if open_state is True or open_state == "true":
                        solid = False
        self._probe_cache[key] = (solid, now)
        return solid

    def enemy_banner_id(self, team):
        if self._registry_id is None:
            name = "blue_banner" if team == "left" else "red_banner"
            block = self.bot.registry.blocksByName[name]
            self._registry_id = int(block.id)
        return self._registry_id

    def scan_enemy_banners(self, team):
        """Live enemy banner positions via the bounded Node-side scan (~2ms)."""
        now = time.time()
        if now - self._scan_cache[0] < 0.7:
            return self._scan_cache[1]
        positions = []
        try:
            for p in self.scans.flags(self.bot, self.enemy_banner_id(team), team):
                positions.append({"x": float(p.x), "z": float(p.z)})
        except Exception:
            log.exception("banner scan failed")
        self._scan_cache = (now, positions)
        return positions

    @staticmethod
    def _block_properties(block):
        try:
            return block.getProperties()
        except Exception:
            return None

    def block_is_air(self, x, y, z):
        """True when the block is air; None means unknown (chunk not loaded)."""
        BLOCK_READ_STATS["count"] += 1
        try:
            block = self.bot.blockAt(self.vec3(x, y, z))
        except Exception:
            return None
        if block is None:
            return None
        return str(block.name) == "air"

    # -- control ---------------------------------------------------------

    def chat(self, text):
        self.bot.chat(text)

    def look_at(self, x, y, z, force=True):
        try:
            self.bot.lookAt(self.vec3(x, y, z), force)
        except Exception:
            pass

    def control(self, name, value):
        try:
            self.bot.setControlState(name, value)
        except Exception:
            pass

    def clear_controls(self):
        try:
            self.bot.clearControlStates()
        except Exception:
            pass

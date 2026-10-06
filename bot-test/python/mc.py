"""Minimal Minecraft Java Edition 1.21.8 (protocol 772) client for CTF bots.

Implements exactly the packet surface the local CTF bots need — offline-mode
login, the 1.20.2+ configuration phase, keep-alive, position sync, and chat —
with the standard library only. Packet ids and field layouts follow
node_modules/minecraft-data (data/pc/1.21.8/protocol.json).

Movement is packet-level (like ctf_bot.js): you teleport-style step your own
position; the server does all gameplay checks (pickup, deposit, jail).
"""

import hashlib
import json
import logging
import socket
import struct
import threading
import time
import zlib

log = logging.getLogger("mc")

PROTOCOL_VERSION = 772

# play/toServer packet ids
S_TELEPORT_CONFIRM = 0x00
S_CHAT_COMMAND = 0x06
S_CHAT_MESSAGE = 0x08
S_SETTINGS = 0x0D
S_KEEP_ALIVE = 0x1B
S_POSITION = 0x1D
S_POSITION_LOOK = 0x1E
S_FLYING = 0x20

# play/toClient packet ids
C_KEEP_ALIVE = 0x26
C_PLAYER_CHAT = 0x3A
C_KICK_DISCONNECT = 0x1C
C_POSITION = 0x41
C_SYSTEM_CHAT = 0x72


# ---------------------------------------------------------------------------
# wire primitives

def write_varint(value):
    out = bytearray()
    value &= 0xFFFFFFFF
    while True:
        if value & ~0x7F == 0:
            out.append(value)
            return bytes(out)
        out.append((value & 0x7F) | 0x80)
        value >>= 7


def read_varint(data, offset):
    result = 0
    for i in range(5):
        if offset >= len(data):
            raise ValueError("varint truncated")
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << (7 * i)
        if not byte & 0x80:
            return result, offset
    raise ValueError("varint too long")


def write_string(text):
    raw = text.encode("utf-8")
    return write_varint(len(raw)) + raw


def read_string(data, offset):
    length, offset = read_varint(data, offset)
    raw = data[offset:offset + length]
    if len(raw) != length:
        raise ValueError("string truncated")
    return raw.decode("utf-8"), offset + length


def write_uuid(value):
    return value.bytes


def read_uuid(data, offset):
    return uuid_from_bytes(data[offset:offset + 16]), offset + 16


def uuid_from_bytes(raw):
    import uuid
    return uuid.UUID(bytes=bytes(raw))


def offline_uuid(username):
    # Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name): MD5, version 3.
    digest = bytearray(hashlib.md5(b"OfflinePlayer:" + username.encode("utf-8")).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return uuid_from_bytes(digest)


# ---------------------------------------------------------------------------
# minimal NBT reader (big-endian, anonymous root) + chat component text

def _nbt_payload(tag_type, data, offset):
    if tag_type == 1:
        return int.from_bytes(data[offset:offset + 1], "big", signed=True), offset + 1
    if tag_type == 2:
        return int.from_bytes(data[offset:offset + 2], "big", signed=True), offset + 2
    if tag_type == 3:
        return int.from_bytes(data[offset:offset + 4], "big", signed=True), offset + 4
    if tag_type == 4:
        return int.from_bytes(data[offset:offset + 8], "big", signed=True), offset + 8
    if tag_type == 5:
        return struct.unpack_from(">f", data, offset)[0], offset + 4
    if tag_type == 6:
        return struct.unpack_from(">d", data, offset)[0], offset + 8
    if tag_type == 7:
        length = int.from_bytes(data[offset:offset + 4], "big", signed=True)
        return bytes(data[offset + 4:offset + 4 + length]), offset + 4 + length
    if tag_type == 8:
        length = int.from_bytes(data[offset:offset + 2], "big", signed=True)
        return data[offset + 2:offset + 2 + length].decode("utf-8"), offset + 2 + length
    if tag_type == 9:
        inner_type = data[offset]
        offset += 1
        length = int.from_bytes(data[offset:offset + 4], "big", signed=True)
        offset += 4
        values = []
        for _ in range(length):
            value, offset = _nbt_payload(inner_type, data, offset)
            values.append(value)
        return values, offset
    if tag_type == 10:
        result = {}
        while True:
            inner_type = data[offset]
            offset += 1
            if inner_type == 0:
                return result, offset
            length = int.from_bytes(data[offset:offset + 2], "big", signed=True)
            name = data[offset + 2:offset + 2 + length].decode("utf-8")
            offset += 2 + length
            result[name], offset = _nbt_payload(inner_type, data, offset)
        return result, offset
    if tag_type == 11:
        length = int.from_bytes(data[offset:offset + 4], "big", signed=True)
        values = list(struct.unpack_from(">%di" % length, data, offset + 4))
        return values, offset + 4 + 4 * length
    if tag_type == 12:
        length = int.from_bytes(data[offset:offset + 4], "big", signed=True)
        values = list(struct.unpack_from(">%dq" % length, data, offset + 4))
        return values, offset + 4 + 8 * length
    raise ValueError("unsupported NBT tag type %d" % tag_type)


def read_anonymous_nbt(data, offset):
    tag_type = data[offset]
    offset += 1
    if tag_type == 0:
        return None, offset
    return _nbt_payload(tag_type, data, offset)


def component_text(value):
    """Flatten a chat component (parsed NBT / dict / list / str) to plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "".join(component_text(item) for item in value)
    if isinstance(value, dict):
        text = value.get("text", "")
        if not text and value.get("translate"):
            args = value.get("with") or value.get("using")
            text = value["translate"]
            if args:
                text += " " + component_text(args)
        extra = value.get("extra") or value.get("with") or []
        return component_text(text) + component_text(extra)
    return ""


# ---------------------------------------------------------------------------
# packet field helpers (per 1.21.8 protocol.json)

def encode_client_information():
    return (
        write_string("zh_cn")
        + struct.pack(">b", 6)      # viewDistance i8
        + write_varint(0)           # chatFlags: enabled
        + struct.pack(">B", 1)      # chatColors
        + struct.pack(">B", 127)    # skinParts
        + write_varint(1)           # mainHand: right
        + struct.pack(">B", 0)      # enableTextFiltering
        + struct.pack(">B", 1)      # enableServerListing
        + write_varint(0)           # particleStatus: all
    )


def encode_chat_message(message):
    # signature option absent, salt 0, offset 0, acknowledged 3 zero bytes,
    # checksum 0 — offline-mode bots never sign.
    now = int(time.time() * 1000) & 0xFFFFFFFFFFFFFFFF
    return (
        write_string(message)
        + struct.pack(">q", now)
        + struct.pack(">q", 0)
        + b"\x00"
        + write_varint(0)
        + b"\x00\x00\x00"
        + b"\x00"
    )


def encode_position(x, y, z, on_ground=True):
    return struct.pack(">ddd", x, y, z) + struct.pack(">B", 1 if on_ground else 0)


def encode_position_look(x, y, z, yaw, pitch, on_ground=True):
    return struct.pack(">dddff", x, y, z, yaw, pitch) + struct.pack(">B", 1 if on_ground else 0)


def encode_flying(on_ground=True):
    return struct.pack(">B", 1 if on_ground else 0)


class Position:
    def __init__(self):
        self.x = 0.0
        self.y = 0.0
        self.z = 0.0
        self.yaw = 0.0
        self.pitch = 0.0


def apply_position_sync(position, payload):
    # 0x41: teleportId varint, x y z dx dy dz f64, yaw pitch f32, flags u32
    offset = 0
    teleport_id, offset = read_varint(payload, offset)
    x, y, z = struct.unpack_from(">ddd", payload, offset)
    offset += 24
    dx, dy, dz = struct.unpack_from(">ddd", payload, offset)
    offset += 24
    yaw, pitch = struct.unpack_from(">ff", payload, offset)
    offset += 8
    flags = struct.unpack_from(">I", payload, offset)[0]
    if flags & 0x01:
        position.x += x
    else:
        position.x = x
    if flags & 0x02:
        position.y += y
    else:
        position.y = y
    if flags & 0x04:
        position.z += z
    else:
        position.z = z
    if flags & 0x08:
        position.yaw += yaw
    else:
        position.yaw = yaw
    if flags & 0x10:
        position.pitch += pitch
    else:
        position.pitch = pitch
    # velocity deltas (dx/dy/dz bits) are ignored: bots do not simulate physics
    return teleport_id


# ---------------------------------------------------------------------------
# client

class MinecraftClient:
    """Blocking per-thread client. Chat arrives via on_chat(text); movement and
    chat are sendable from any thread (a lock serialises the socket writes)."""

    def __init__(self, host, port, username, on_chat=None, on_end=None):
        self.host = host
        self.port = port
        self.username = username
        self.on_chat = on_chat or (lambda text: None)
        self.on_end = on_end or (lambda reason: None)
        self.position = Position()
        self.state = "handshake"
        self.compression_threshold = None
        self.connected = False
        self.play_ready = False
        self._socket = None
        self._send_lock = threading.Lock()
        self._stopped = False
        self._thread = None

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self._thread = threading.Thread(target=self._run, name="mc-" + self.username, daemon=True)
        self._thread.start()
        return self._thread

    def close(self, reason="client quit"):
        self._stopped = True
        try:
            if self._socket:
                self._socket.close()
        except OSError:
            pass

    def _run(self):
        try:
            self._socket = socket.create_connection((self.host, self.port), timeout=30)
            self._socket.settimeout(30)
            self._login()
            self._loop()
        except (OSError, ValueError, zlib.error) as error:
            if not self._stopped:
                log.info("[%s] connection error: %s", self.username, error)
        finally:
            self.connected = False
            self.close()
            self.on_end("disconnected" if not self._stopped else "quit")

    # -- framing -----------------------------------------------------------

    def _recv_exact(self, count):
        chunks = []
        while count > 0:
            chunk = self._socket.recv(count)
            if not chunk:
                raise OSError("connection closed")
            chunks.append(chunk)
            count -= len(chunk)
        return b"".join(chunks)

    def _recv_packet(self):
        length = 0
        shift = 0
        while True:
            byte = self._recv_exact(1)[0]
            length |= (byte & 0x7F) << shift
            if not byte & 0x80:
                break
            shift += 7
        payload = self._recv_exact(length)
        if self.compression_threshold is not None:
            data_length, offset = read_varint(payload, 0)
            body = payload[offset:]
            if data_length != 0:
                body = zlib.decompress(body)
                if len(body) != data_length:
                    raise ValueError("bad decompressed length")
            payload = body
        packet_id, offset = read_varint(payload, 0)
        return packet_id, payload[offset:]

    def _send(self, packet_id, payload=b""):
        body = write_varint(packet_id) + payload
        if self.compression_threshold is not None and len(body) >= self.compression_threshold:
            compressed = zlib.compress(body)
            frame = write_varint(len(body)) + compressed
        elif self.compression_threshold is not None:
            frame = write_varint(0) + body
        else:
            frame = body
        packet = write_varint(len(frame)) + frame
        with self._send_lock:
            self._socket.sendall(packet)

    # -- login / configuration / play -------------------------------------

    def _login(self):
        handshake = (
            write_varint(PROTOCOL_VERSION)
            + write_string(self.host)
            + struct.pack(">H", self.port)
            + write_varint(2)
        )
        self._send(0x00, handshake)
        self.state = "login"
        login_start = write_string(self.username) + write_uuid(offline_uuid(self.username))
        self._send(0x00, login_start)

        while True:
            packet_id, payload = self._recv_packet()
            if self.state == "login":
                if packet_id == 0x03:  # set_compression
                    threshold, _ = read_varint(payload, 0)
                    self.compression_threshold = threshold
                elif packet_id == 0x02:  # login_success
                    _, offset = read_uuid(payload, 0)
                    self.state = "configuration"
                    self._send(0x03)  # login_acknowledged
                    self._send_configuration_settings()
                elif packet_id == 0x00:  # disconnect
                    reason, _ = read_string(payload, 0)
                    raise OSError("kicked during login: " + reason)
            elif self.state == "configuration":
                if packet_id == 0x04:  # keep_alive
                    self._send(0x04, payload)
                elif packet_id == 0x03:  # finish_configuration
                    self._send(0x03)  # finish_configuration
                    self.state = "play"
                    self.connected = True
                    return
                elif packet_id == 0x00:  # select_known_packs request? no — disconnect
                    raise OSError("kicked during configuration")
                elif packet_id == 0x02:  # disconnect
                    text, _ = read_string(payload, 0)
                    raise OSError("kicked during configuration: " + text)
            else:
                raise ValueError("unexpected packet %d during login" % packet_id)

    def _send_configuration_settings(self):
        self._send(0x00, encode_client_information())          # client_information
        self._send(0x07, write_varint(0))                      # select_known_packs: empty

    def _loop(self):
        while not self._stopped:
            packet_id, payload = self._recv_packet()
            if packet_id == C_KEEP_ALIVE:
                self._send(S_KEEP_ALIVE, payload)
            elif packet_id == C_POSITION:
                teleport_id = apply_position_sync(self.position, payload)
                self._send(S_TELEPORT_CONFIRM, write_varint(teleport_id))
                if not self.play_ready:
                    self.play_ready = True
            elif packet_id == C_SYSTEM_CHAT:
                value, _ = read_anonymous_nbt(payload, 0)
                self.on_chat(component_text(value))
            elif packet_id == C_PLAYER_CHAT:
                text = parse_player_chat(payload)
                if text:
                    self.on_chat(text)
            elif packet_id == C_KICK_DISCONNECT:
                value, _ = read_anonymous_nbt(payload, 0)
                raise OSError("kicked: " + component_text(value))

    # -- outbound helpers ---------------------------------------------------

    def send_chat(self, text):
        # Slash messages are commands: since 1.19 they travel in the separate
        # unsigned chat_command packet, not chat_message.
        if text.startswith("/"):
            self._send(S_CHAT_COMMAND, write_string(text[1:]))
            return
        self._send(S_CHAT_MESSAGE, encode_chat_message(text))

    def send_position(self, on_ground=True):
        p = self.position
        self._send(S_POSITION, encode_position(p.x, p.y, p.z, on_ground))

    def send_position_look(self, yaw, pitch, on_ground=True):
        p = self.position
        self._send(S_POSITION_LOOK, encode_position_look(p.x, p.y, p.z, yaw, pitch, on_ground))

    def send_flying(self, on_ground=True):
        self._send(S_FLYING, encode_flying(on_ground))


def parse_player_chat(payload):
    """Extract display text from a player_chat packet (0x3a), or ''."""
    offset = 0
    offset = skip_varint(payload, offset)            # globalIndex
    offset += 16                                     # senderUuid
    offset = skip_varint(payload, offset)            # index
    if payload[offset] == 1:                         # signature present?
        offset += 1 + 256
    else:
        offset += 1
    plain, offset = read_string(payload, offset)
    offset += 8                                      # timestamp
    offset += 8                                      # salt
    count, offset = read_varint(payload, offset)     # previousMessages
    for _ in range(count):
        entry_id, offset = read_varint(payload, offset)
        if entry_id == 0:
            offset += 256
    if payload[offset] == 1:                         # unsignedChatContent present
        offset += 1
        value, offset = read_anonymous_nbt(payload, offset)
        return component_text(value)
    return plain


def skip_varint(data, offset):
    _, offset = read_varint(data, offset)
    return offset

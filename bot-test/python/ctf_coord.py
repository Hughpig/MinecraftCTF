"""[CTFC] team chat protocol shared by the pyjump bots: cross-process
coordination over plain chat. Mirrors bot-test/ctf-coord.js line for line —
every listener applies the same transition, so delivery order does not matter.

    c <x>,<z>   claim the enemy flag at that block (short lease, like claims)
    u <x>,<z>   release that claim early (picked up, vanished, gave up)
    r <name>    I am taking the rescue — one in-flight rescue per team covers
                the whole door, because one plate press frees every prisoner
    f           team freed (door opened): clear jailed entries + rescue duty
"""

CHAT_PREFIX = "[CTFC]"


def parse_coordination(message, username, teammates):
    """Return (sender, command, arg) for a teammate's [CTFC] line, else None.

    System broadcasts have no <sender>, own lines are dropped, and opponents'
    lines fail the teammate check — all parse to None.
    """
    if not message or CHAT_PREFIX not in message:
        return None
    if not (message.startswith("<") and ">" in message):
        return None
    sender, _, rest = message[1:].partition(">")
    rest = rest.strip()
    if sender == username or not rest.startswith(CHAT_PREFIX):
        return None
    parts = [p for p in rest[len(CHAT_PREFIX):].strip().split() if p]
    if not parts or not teammates or sender not in teammates:
        return None
    return sender, parts[0], (parts[1] if len(parts) > 1 else "")


def claim_key(x, z):
    # Rounded block coordinates so the Node and Python banner scans
    # (independent implementations) agree on the same key.
    return f"{int(round(x))},{int(round(z))}"


def claim_message(key):
    return f"c {key}"


def unclaim_message(key):
    return f"u {key}"


def rescue_message(name):
    return f"r {name}"


def freed_message():
    return "f"

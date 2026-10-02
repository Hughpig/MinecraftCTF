# Local-only Mineflayer smoke test

This directory is independent from the original `ctf_bot.js`. It never uses the old public address.

```powershell
npm install
npm run smoke
```

Defaults:

- server: `127.0.0.1:25565`
- bots: 2 (one bot per team after server auto-balancing)
- players per team: 1
- map: fixed
- active team: both (both teams move at the same time; a captured bot waits for release)

Overrides:

```powershell
$env:CTF_BOTS=4
$env:CTF_PLAYERS=2
npm run smoke
```

The bots send the documented `match ... players:<n> map:fixed` chat protocol, reply to `Are you ready?`, and parse `Game start: ...`. Active bots steer directly between the map's two flag columns and two goal columns, jump over obstacles, and wait for server pickup/capture confirmations. Multiple teammates split the eight routes.

Set `CTF_ACTIVE_TEAM=left` or `CTF_ACTIVE_TEAM=right` to test one side only. `CTF_ACTIVE_TEAM=both` runs a contested match; bots understand the server's capture/release messages and pause while jailed. The default is now `both`, so the smoke test exercises simultaneous offense and the prison path, but it remains a route test rather than tactical AI.

The test waits for `Game over!` and prints `PASS` only if the server has confirmed at least one pickup and capture. Connection/startup, movement, or confirmation failures produce a nonzero exit code; the overall deadline is 210 seconds, longer than the 180-second match. Check the server's new `events.jsonl` entries for authoritative scores and end reason. This is not a visual Minecraft client.

## Verified local run

On October 2, 2026, the default two-bot test completed in about 86 seconds on Paper 1.21.8 build 60 / Java 25.0.1. New server events confirmed eight distinct flag pickups, eight distinct target captures, and `match_end` with `reason=eight_captures_left`, `left=8`, `right=0`. The bot printed `PASS`, and the current server log contained no errors or exceptions. This validates the scoring/victory path, not every capture, prison, death, or disconnection rule.

The detached verification logs are `smoke-verification.log` and `smoke-verification-error.log` in this directory; ordinary `npm run smoke` writes to the terminal.

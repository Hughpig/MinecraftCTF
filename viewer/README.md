# MinecraftCTF 2D live viewer

A local, top-down spectator view inspired by the camp viewer: white grid, dark walls/prisons, red/blue players and flag squares, and gold target outlines. Captured targets are filled with the captured flag's red/blue color, reported by Paper; the gold border remains visible. This is a viewer-only presentation change: the in-world emerald marker and game rules are unchanged. The existing fixed map is not rearranged to imitate the reference image.

## Run

1. Build and deploy the updated plugin, then start Paper with `../server/run-local.ps1`. The plugin writes `server/plugins/MinecraftCTF/viewer-state.json` four times per second.
2. From this directory run `npm start`, then open `http://127.0.0.1:3000`.
3. Click **开始演示局**. This launches the existing local smoke bots and generates the map. Alternatively run `npm run smoke` in `bot-test` or join the server with a Java client.

The viewer has no npm dependencies or external assets. The demo needs the existing `bot-test/node_modules`; run `npm install` in `bot-test` if missing. Set `CTF_VIEWER_PORT` to change the web port.

## What is live

- Player coordinates, team, flag carrier state, and prison countdown. The demo starts both teams at once; a bot pauses when the server reports capture and resumes after release.
- Actual flag locations (including dropped flags), locked targets, authoritative score, remaining time, result, and recent events.
- Walls, prisons, and the central divider from the generated map. Mooshrooms and other animals are intentionally not rendered in this first version.
- Red/blue view buttons rotate the map; they do not change a player's team. Names can be hidden and markers have hover details.

The page is a spectator tool, not a Minecraft client: it does not offer WASD control or decide game rules. A stopped or stale Paper feed is explicitly marked disconnected; the background may retain its last snapshot. After a Paper restart, generate the map before viewing it, because the current MVP does not reconstruct map metadata from saved blocks.

## Architecture and safety

Paper captures data on its main thread and sends serialized snapshots to a coalescing background writer. Files are atomically replaced, and shutdown publishes `online=false`. The Node.js gateway serves a fixed asset allowlist, reads only the snapshot, and streams it to the page using SSE. It does not infer scores from client movement.

Both Paper and the viewer bind to loopback. Starting a demo requires a same-origin request and a per-process token, has no arbitrary command arguments, and is rejected while a match or demo is already running. The demo always uses `127.0.0.1:25565`; it never runs the original public-address `ctf_bot.js`. Only use this local development service on your own machine.

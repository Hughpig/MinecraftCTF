# MinecraftCTF 2D live viewer

A local, top-down spectator view inspired by the camp viewer: white grid, dark walls/prisons, red/blue players and flag squares, and gold target outlines. Captured targets are filled with the captured flag's red/blue color, reported by Paper; the gold border remains visible. This is a viewer-only presentation change: the in-world emerald marker and game rules are unchanged. The existing fixed map is not rearranged to imitate the reference image.

## Run

1. Build and deploy the updated plugin, then start Paper with `../server/run-local.ps1`. The plugin captures `server/plugins/MinecraftCTF/viewer-state.json` every four server ticks (5 Hz at 20 TPS).
2. From this directory run `npm start`, then open `http://127.0.0.1:3000`.
3. Click **开始演示局**. This launches the existing local smoke bots and generates the map. Alternatively run `npm run smoke` in `bot-test` or join the server with a Java client.

The viewer has no npm dependencies or external assets. The demo needs the existing `bot-test/node_modules`; run `npm install` in `bot-test` if missing. Set `CTF_VIEWER_PORT` to change the web port.

## What is live

- Player coordinates, team, flag carrier state, prison countdown, and prison-door state. The demo starts both teams at once; a bot waits inside the prison until its door opens, then walks out without a teleport.
- Actual flag locations (including dropped flags), locked targets, authoritative score, remaining time, result, and recent events.
- Walls, prisons, and the central divider from the generated map. Mooshrooms and other animals are intentionally not rendered in this first version.
- Red/blue view buttons rotate the map; they do not change a player's team. Names can be hidden and markers have hover details.

The page is a spectator tool, not a Minecraft client: it does not offer WASD control or decide game rules. A stopped or stale Paper feed is explicitly marked disconnected; the background may retain its last snapshot. After a Paper restart, generate the map before viewing it, because the current MVP does not reconstruct map metadata from saved blocks.

## Architecture and safety

Paper captures detached data on its main thread; a coalescing background writer serializes and publishes it immediately, without a second polling timer. Snapshots are written to a sibling temporary file and atomically replaced (with a replace-move fallback on filesystems without atomic moves), so readers never see a truncated JSON file. Short background retries handle transient Windows file locks. Shutdown publishes `online=false`. The Node.js gateway polls every 100 ms, skips unchanged snapshots and streams updates using SSE. It does not infer scores from client movement.

The browser interpolates player positions with a 300 ms buffer. At match start it blends from the newest frame into the buffered timeline instead of switching back to an older frame abruptly, so opening movement remains continuous. A match phase change clears stale lobby frames. Teleports and capture/release state changes snap to the authoritative position. The map background, prison doors, and objective layer are cached independently, so opening a prison door does not redraw the whole map. Event and roster panels update in a deferred batch so their DOM rebuild does not compete with the next canvas frame. Player names are rasterized once and reused, and unchanged HUD text is left alone. More players therefore add marker draws without repeating map or text work every animation frame.

Run `npm test` in this directory for dependency-free viewer regressions covering 1v1/3v3 draw caching, HUD updates, resize, interpolation, teleports and reconnects. After updating the plugin or gateway, rebuild and restart Paper/the viewer, then reload the page.

Both Paper and the viewer bind to loopback. Starting a demo requires a same-origin request and a per-process token, has no arbitrary command arguments, and is rejected while a match or demo is already running. The demo always uses `127.0.0.1:25565`; it never runs the original public-address `ctf_bot.js`. Only use this local development service on your own machine.

const http = require('node:http');
const fsNative = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { composeGroups, commandFor } = require('../scripts/launch-groups');

const port = Number(process.env.CTF_VIEWER_PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CTF_VIEWER_PORT must be between 1024 and 65535');
const root = path.resolve(__dirname, '..');
const snapshotPath = path.join(root, 'server', 'plugins', 'MinecraftCTF', 'viewer-state.json');
const snapshotDirectory = path.dirname(snapshotPath);
const snapshotFilename = path.basename(snapshotPath);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const token = crypto.randomBytes(24).toString('hex');
const clients = new Set();
let snapshot = null;
let cachedBlocks = null;
let cachedBlocksKey = null;
let demo = { status: 'idle', message: '' };
const demoProcesses = new Set();
let stopRequested = false;

function stopDemoProcesses() {
  for (const child of demoProcesses) {
    try { child.kill(); } catch (_) {}
  }
}

function startLaunch(config) {
  const groups = composeGroups(config);
  stopDemoProcesses();
  stopRequested = false;
  demo = { status: 'running', message: `已启动 ${groups.map(group => `${group.label}×${group.count}`).join('、')}，机器人正在连接本地 Paper…` };
  let output = '';
  let closed = 0;
  let failed = 0;
  const collect = chunk => { output = (output + chunk.toString()).slice(-16000); };
  for (const group of groups) {
    const runner = commandFor(group.style, root);
    const child = spawn(runner.command, runner.args, {
      cwd: path.join(root, 'bot-test'),
      windowsHide: true,
      env: { ...process.env, CTF_HOST: '127.0.0.1', CTF_PORT: '25565', ...group.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    demoProcesses.add(child);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => {
      failed++;
      demo = { status: 'failed', message: `${group.label} 启动失败：${error.message}` };
      broadcast();
    });
    child.on('close', code => {
      demoProcesses.delete(child);
      closed++;
      if (code !== 0) failed++;
      if (closed === groups.length && !stopRequested) {
        const smoke = output.split(/\r?\n/).findLast(line => line.includes('[smoke]'));
        demo = failed > 0
          ? { status: 'failed', message: smoke || `${failed}/${groups.length} 个机器人进程异常退出` }
          : { status: 'succeeded', message: smoke || '全部机器人已退出' };
        broadcast();
      }
    });
  }
  broadcast();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error('请求体过大'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
let previousState = null;
let previousSnapshot = '';
let reading = false;
let refreshQueued = false;
let refreshAgain = false;

function currentState() {
  return {
    connected: !!snapshot && snapshot.online === true && Date.now() - snapshot.updatedAt < 3000,
    snapshot,
    demo
  };
}

function blocksKey(state) {
  return `${state.mapVersion ?? 0}:${state.mapBuilt === true}`;
}

function withBlocks(state) {
  if (!state.snapshot || Array.isArray(state.snapshot.blocks) || cachedBlocksKey !== blocksKey(state.snapshot)) return state;
  return { ...state, snapshot: { ...state.snapshot, blocks: cachedBlocks } };
}

function broadcast() {
  const state = currentState();
  if (previousState && state.connected === previousState.connected && state.snapshot === previousState.snapshot && state.demo === previousState.demo) return;
  previousState = state;
  const message = JSON.stringify(state);
  for (const client of clients) client.write(`data: ${message}\n\n`);
}

async function refresh() {
  if (reading) {
    refreshAgain = true;
    return;
  }
  reading = true;
  try {
    const content = await fs.readFile(snapshotPath, 'utf8');
    if (content !== previousSnapshot) {
      const candidate = JSON.parse(content);
      if (candidate.schemaVersion === 1 && Number.isFinite(candidate.updatedAt)) {
        if (Array.isArray(candidate.blocks)) {
          cachedBlocks = candidate.blocks;
          cachedBlocksKey = blocksKey(candidate);
        }
        snapshot = candidate;
        previousSnapshot = content;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EPERM' && !(error instanceof SyntaxError)) console.error(`Snapshot read failed: ${error.message}`);
  } finally {
    reading = false;
    broadcast();
    if (refreshAgain) {
      refreshAgain = false;
      queueRefresh();
    }
  }
}

function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refresh();
  }, 10);
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function startDemo() {
  let output = '';
  demo = { status: 'running', message: '机器人正在连接本地 Paper…' };
  demoProcess = spawn(process.execPath, [path.join(root, 'bot-test', 'local_bot_test.js')], {
    cwd: path.join(root, 'bot-test'),
    windowsHide: true,
    env: { ...process.env, CTF_HOST: '127.0.0.1', CTF_PORT: '25565', CTF_BOTS: '2', CTF_PLAYERS: '1', CTF_ACTIVE_TEAM: 'both' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const collect = chunk => { output = (output + chunk.toString()).slice(-16000); };
  demoProcess.stdout.on('data', collect);
  demoProcess.stderr.on('data', collect);
  demoProcess.on('error', error => {
    demo = { status: 'failed', message: error.message };
    demoProcess = null;
    broadcast();
  });
  demoProcess.on('close', code => {
    const summary = output.split(/\r?\n/).findLast(line => line.includes('[smoke]'));
    demo = { status: code === 0 ? 'succeeded' : 'failed', message: summary || `机器人已退出，状态码 ${code}` };
    demoProcess = null;
    broadcast();
  });
  broadcast();
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (!allowedHosts.has(request.headers.host)) return json(response, 403, { error: 'Local viewer host required' });
  const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/api/launch' && request.method === 'POST') {
    const origin = request.headers.origin;
    if (!origin || ![...allowedHosts].some(host => origin === `http://${host}`) || request.headers['x-viewer-token'] !== token)
      return json(response, 403, { error: '请从本机 viewer 页面启动。' });
    const state = currentState();
    if (!state.connected) return json(response, 409, { error: 'Paper 尚未连接，请先启动服务端。' });
    if (demoProcesses.size > 0 || snapshot.phase === 'running') return json(response, 409, { error: '已有比赛或演示正在进行。' });
    try {
      const config = JSON.parse((await readBody(request)) || '{}');
      startLaunch(config);
      return json(response, 202, { ok: true });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }
  if (pathname === '/api/stop' && request.method === 'POST') {
    const origin = request.headers.origin;
    if (!origin || ![...allowedHosts].some(host => origin === `http://${host}`) || request.headers['x-viewer-token'] !== token)
      return json(response, 403, { error: '请从本机 viewer 页面操作。' });
    if (demoProcesses.size === 0) return json(response, 409, { error: '当前没有运行中的机器人。' });
    stopRequested = true;
    demo = { status: 'idle', message: '已停止，可再次启动。' };
    stopDemoProcesses();
    broadcast();
    return json(response, 202, { ok: true });
  }
  if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed' });
  if (pathname === '/api/session') return json(response, 200, { token });
  if (pathname === '/api/state') return json(response, 200, withBlocks(currentState()));
  if (pathname === '/api/stream') {
    if (clients.size >= 16) return json(response, 503, { error: 'Too many viewer connections' });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`data: ${JSON.stringify(withBlocks(currentState()))}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  const asset = assets.get(pathname);
  if (!asset) return json(response, 404, { error: 'Not found' });
  try {
    const body = await fs.readFile(path.join(__dirname, 'public', asset[0]));
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(body);
  } catch (error) {
    console.error(error.message);
    json(response, 500, { error: 'Viewer asset unavailable' });
  }
});

// ViewerStateWriter replaces the snapshot atomically. Watching the containing
// directory lets us forward a new state as soon as the rename is visible,
// while the slower timer remains as a recovery path for missed Windows events.
let snapshotWatcher = null;
try {
  snapshotWatcher = fsNative.watch(snapshotDirectory, { persistent: false }, (_eventType, filename) => {
    const name = filename ? filename.toString() : '';
    if (!name || name === snapshotFilename || name === `${snapshotFilename}.tmp`) queueRefresh();
  });
  snapshotWatcher.on('error', error => console.error(`Snapshot watcher failed: ${error.message}`));
} catch (error) {
  console.error(`Snapshot watcher unavailable: ${error.message}`);
}
const refreshTimer = setInterval(refresh, 500);
const heartbeatTimer = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 10000);
server.on('error', error => { console.error(error.message); process.exitCode = 1; clearInterval(refreshTimer); clearInterval(heartbeatTimer); snapshotWatcher?.close(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`MinecraftCTF viewer: http://127.0.0.1:${port}`);
  console.log(`Authoritative state: ${snapshotPath}`);
  refresh();
});

function shutdown() {
  clearInterval(refreshTimer); clearInterval(heartbeatTimer);
  snapshotWatcher?.close();
  stopDemoProcesses();
  for (const client of clients) client.end();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

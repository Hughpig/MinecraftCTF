const minecraft = require('minecraft-protocol');

const username = process.argv[3] || process.argv[2] || 'SimpleCTF_0';
const host = process.env.CTF_HOST || '127.0.0.1';
const port = Number(process.env.CTF_PORT || 25565);
const playersPerTeam = Number(process.env.CTF_PLAYERS || 3);
const teamSide = process.env.CTF_SIDE;
const setup = process.env.CTF_SETUP === '1';
const version = process.env.CTF_VERSION || '1.21.8';
const CONTROL_INTERVAL = 100;
const STEP_DISTANCE = 0.16;
const FLAG_ROWS = [-30, -22, -14, -6];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const client = minecraft.createClient({ host, port, auth: 'offline', version, username, keepAlive: false, clientSettings: { viewDistance: 2 } });
let team = null;
let running = false;
let carrying = false;
let jailed = false;
let stopped = false;
let current = { x: 0, y: 64, z: 0.5, yaw: 0, pitch: 0 };
let heartbeatTimer = null;
let jailReleaseTimer = null;
let stateWaiters = [];

function log(message) { console.log(`[simple:${username}] ${message}`); }

function sendPosition() {
  if (stopped || client.state !== 'play') return;
  client.write('position', { x: current.x, y: current.y, z: current.z, flags: { onGround: true, hasHorizontalCollision: false } });
}

function sendHeartbeat() {
  if (stopped || client.state !== 'play') return;
  client.write('flying', { onGround: true, flags: { onGround: true, hasHorizontalCollision: false } });
}

function chat(message) { if (!stopped && client.state === 'play') client.chat(message); }
function isHomeX(x) { return team === 'left' ? x < 0 : x > 0; }

function inOwnPrison() {
  if (!team) return false;
  const side = team === 'left' ? current.x >= -20 && current.x <= -12 : current.x >= 12 && current.x <= 20;
  return side && current.z >= 24 && current.z <= 32;
}

function nearest(items) {
  return items.reduce((best, item) => {
    if (!best) return item;
    const bestDistance = (best.x - current.x) ** 2 + (best.z - current.z) ** 2;
    const itemDistance = (item.x - current.x) ** 2 + (item.z - current.z) ** 2;
    return itemDistance < bestDistance ? item : best;
  }, null);
}

function enemyFlags() {
  const sign = team === 'left' ? 1 : -1;
  return [18, 10].flatMap(column => FLAG_ROWS.map(z => ({ x: sign * (column - 1), z })));
}

function homeTargets() {
  const sign = team === 'left' ? -1 : 1;
  return [4, 7].flatMap(column => FLAG_ROWS.map(z => ({ x: sign * (column - 1), z })));
}

function notifyStateWaiters() {
  for (const waiter of stateWaiters.splice(0)) waiter();
}

async function waitForState(predicate, timeout = 5000) {
  const started = Date.now();
  while (!stopped && !predicate() && Date.now() - started < timeout) {
    await new Promise(resolve => stateWaiters.push(resolve));
  }
  return !stopped && predicate();
}

async function moveTo(target, range = 0.85) {
  if (!target || stopped) return false;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastDistance = Infinity;
  while (!stopped && !jailed) {
    const dx = target.x - current.x;
    const dz = target.z - current.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= range) return true;
    if (Date.now() - startedAt > 20000 || Date.now() - lastProgressAt > 3000) return false;
    const step = Math.min(STEP_DISTANCE, distance);
    current.x += dx / Math.max(distance, 0.01) * step;
    current.z += dz / Math.max(distance, 0.01) * step;
    sendPosition();
    if (distance < lastDistance - 0.1) {
      lastDistance = distance;
      lastProgressAt = Date.now();
    }
    await sleep(CONTROL_INTERVAL);
  }
  return false;
}

async function leavePrison() {
  const x = team === 'left' ? -15.5 : 16.5;
  await moveTo({ x, z: 23.5 }, 0.85);
}

async function run() {
  if (running || !team) return;
  running = true;
  await sleep(2500);
  const sideIndex = Number((username.match(/(\d+)$/) || [, '0'])[1]);
  const route = enemyFlags().filter((_, index) => index % 3 === sideIndex % 3);
  let routeIndex = 0;
  while (!stopped) {
    if (jailed) { await sleep(500); continue; }
    if (inOwnPrison()) { await leavePrison(); continue; }
    if (!carrying) {
      const flag = route[routeIndex++ % route.length];
      if (!await moveTo(flag)) continue;
      if (!await waitForState(() => carrying, 2500)) continue;
      await sleep(150);
      continue;
    }
    const target = nearest(homeTargets());
    if (!await moveTo(target)) continue;
    await waitForState(() => !carrying, 2500);
    await sleep(150);
  }
}

function componentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    try { return componentText(JSON.parse(value)); } catch (_) { return value; }
  }
  if (Array.isArray(value)) return value.map(componentText).join('');
  if (typeof value === 'object') return `${value.text || value.translate || ''}${componentText(value.extra || [])}`;
  return String(value);
}

function armJailReleaseFallback() {
  if (jailReleaseTimer) clearTimeout(jailReleaseTimer);
  jailReleaseTimer = setTimeout(() => {
    jailReleaseTimer = null;
    if (jailed && !stopped) {
      jailed = false;
      notifyStateWaiters();
      log('jail timer fallback: leaving prison');
    }
  }, 31000);
}

function handleMessage(message) {
  if (!message) return;
  if (message.includes('你携带了')) {
    carrying = true;
    notifyStateWaiters();
    return;
  }
  if (message.includes('插旗成功！') || message.includes('旗已在附近重新立起')) {
    carrying = false;
    notifyStateWaiters();
    return;
  }
  if (message.includes('你被') && message.includes('关入')) {
    jailed = true;
    carrying = false;
    notifyStateWaiters();
    armJailReleaseFallback();
    return;
  }
  if (message.includes('监狱门已打开')) {
    jailed = false;
    notifyStateWaiters();
    if (jailReleaseTimer) clearTimeout(jailReleaseTimer);
    jailReleaseTimer = null;
    return;
  }
  if (message.includes('Game over!')) { stop(); return; }
  if (message.includes('Are you ready?')) { chat("I'm ready!"); return; }
  const start = message.indexOf('Game start: ');
  if (start < 0) return;
  try {
    const data = JSON.parse(message.slice(start + 'Game start: '.length));
    team = data.left?.includes(username) ? 'left' : data.right?.includes(username) ? 'right' : null;
    if (team) { log(`started for ${team}`); run().catch(error => log(error.stack || error.message)); }
  } catch (error) { log(`invalid start message: ${error.message}`); }
}

function stop() {
  if (stopped) return;
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (jailReleaseTimer) clearTimeout(jailReleaseTimer);
  try { client.end('quitting'); } catch (_) {}
}

client.on('playerJoin', () => {
  log(`connected to ${host}:${port}`);
  heartbeatTimer = setInterval(sendHeartbeat, 1000);
  setTimeout(() => {
    if (setup) chat('/ctf setup');
    setTimeout(() => {
      if (teamSide) chat(`/ctf join ${teamSide}`);
      setTimeout(() => chat(`match team:simple-bots enemy:bot players:${playersPerTeam} map:fixed`), 400);
    }, setup ? 700 : 250);
  }, 200);
});

client.on('keep_alive', packet => {
  if (stopped || client.state !== 'play') return;
  client.write('keep_alive', { keepAliveId: packet.keepAliveId });
});

client.on('position', packet => {
  const flags = packet.flags || {};
  current.x = flags.x ? current.x + packet.x : packet.x;
  current.y = flags.y ? current.y + packet.y : packet.y;
  current.z = flags.z ? current.z + packet.z : packet.z;
  if (flags.yaw) current.yaw += packet.yaw; else current.yaw = packet.yaw;
  if (flags.pitch) current.pitch += packet.pitch; else current.pitch = packet.pitch;
  if (packet.teleportId !== undefined) client.write('teleport_confirm', { teleportId: packet.teleportId });
});

client.on('systemChat', packet => handleMessage(componentText(packet.formattedMessage)));
client.on('playerChat', packet => handleMessage(packet.plainMessage || componentText(packet.unsignedContent)));
client.on('error', error => log(`error: ${error.message}`));
client.on('end', reason => {
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (jailReleaseTimer) clearTimeout(jailReleaseTimer);
  log(`disconnected: ${reason || 'unknown'}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);

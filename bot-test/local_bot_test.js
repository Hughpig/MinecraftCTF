const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const HOST = process.env.CTF_HOST || '127.0.0.1';
const PORT = Number(process.env.CTF_PORT || 25565);
const BOT_COUNT = Math.max(1, Math.min(16, Number(process.env.CTF_BOTS || 2)));
const PLAYERS_PER_TEAM = Math.max(1, Math.min(16, Number(process.env.CTF_PLAYERS || 1)));
const ACTIVE_TEAM = process.env.CTF_ACTIVE_TEAM || 'both';
const MATCH = `match team:local-bots enemy:bot players:${PLAYERS_PER_TEAM} map:fixed`;
const bots = [];
let stopping = false;
let gameEnded = false;
let finishTimer;
let confirmMapReady;
const mapReady = new Promise(resolve => { confirmMapReady = resolve; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (name, message) => console.log(`[${new Date().toISOString()}] [${name}] ${message}`);

function makeBot(index) {
  const username = `LocalCTF_${index + 1}`;
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username, auth: 'offline', version: '1.21.8' });
  bot.ctf = { index, team: null, started: false, routeRunning: false, carrying: false, jailed: false, pickups: 0, captures: 0 };

  bot.once('spawn', async () => {
    log(username, `connected to ${HOST}:${PORT}`);
    if (index === 0) {
      bot.chat('/ctf setup');
    }
    await mapReady;
    if (stopping) return;
    bot.chat(MATCH);
  });

  bot.on('messagestr', message => {
    log(username, message);
    if (message.includes('固定地图已生成：')) confirmMapReady();
    if (message.includes('Are you ready?')) bot.chat("I'm ready!");
    if (message.startsWith('Game start: ')) {
      try {
        const teams = JSON.parse(message.slice('Game start: '.length));
        bot.ctf.team = teams.left.includes(username) ? 'left' : teams.right.includes(username) ? 'right' : null;
        if (bot.ctf.team) {
          bot.ctf.teamIndex = teams[bot.ctf.team].indexOf(username);
          bot.ctf.teamSize = teams[bot.ctf.team].length;
        }
        if (bot.ctf.team && !bot.ctf.started) {
          bot.ctf.started = true;
          if (ACTIVE_TEAM === 'both' || ACTIVE_TEAM === bot.ctf.team) {
            runRoute(bot).catch(err => { log(username, `route error: ${err.stack || err}`); stopAll(); });
          }
        }
      } catch (err) {
        log(username, `cannot parse game start: ${err.message}`);
      }
    }
    if (message.includes('你携带了')) { bot.ctf.carrying = true; bot.ctf.pickups++; }
    if (message.includes('插旗成功！')) { bot.ctf.carrying = false; bot.ctf.captures++; }
    if (message.includes('旗已在附近重新立起')) bot.ctf.carrying = false;
    if (message.includes('被抓捕并关入')) bot.ctf.jailed = true;
    if (message.includes('监禁结束') || message.includes('已获释')) bot.ctf.jailed = false;
    if (message.includes('Game over!') && bot.ctf.started) {
      gameEnded = true;
      if (!finishTimer) finishTimer = setTimeout(stopAll, 200);
    }
  });

  bot.on('error', err => log(username, `error: ${err.message}`));
  bot.on('kicked', reason => log(username, `kicked: ${JSON.stringify(reason)}`));
  bot.on('end', reason => log(username, `disconnected: ${reason || 'unknown'}`));
  bots.push(bot);
}

async function goNear(bot, x, z, completed = () => false) {
  bot.clearControlStates();
  let started = Date.now();
  let lastLog = 0;
  const target = new Vec3(x, 64, z);
  while (!stopping && Date.now() - started < 15000) {
    if (completed()) { bot.clearControlStates(); return true; }
    if (bot.ctf.jailed) {
      bot.clearControlStates();
      await sleep(250);
      started = Date.now();
      continue;
    }
    if (!bot.entity) { await sleep(100); continue; }
    const position = bot.entity.position;
    const deltaX = target.x - position.x;
    const deltaZ = target.z - position.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance <= 0.3 && Math.abs(position.y - target.y) < 0.2) { bot.clearControlStates(); return true; }
    await bot.lookAt(new Vec3(target.x, position.y + 1.62, target.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    const ahead = bot.blockAt(position.offset(deltaX / Math.max(distance, 0.01) * 0.8, 0.1, deltaZ / Math.max(distance, 0.01) * 0.8));
    bot.setControlState('jump', !!ahead && ahead.boundingBox === 'block');
    if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(bot.username, `position ${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`); }
    await sleep(100);
  }
  bot.clearControlStates();
  if (stopping) return false;
  log(bot.username, `timeout before reaching ${x},${z}`);
  throw new Error(`cannot reach ${x},${z}`);
}

async function waitFor(bot, predicate, description) {
  const started = Date.now();
  while (!stopping && !predicate() && Date.now() - started < 10000) await sleep(50);
  if (!stopping && !predicate()) throw new Error(`server did not confirm ${description}`);
}

async function runRoute(bot) {
  if (bot.ctf.routeRunning) return;
  bot.ctf.routeRunning = true;
  const left = bot.ctf.team === 'left';
  const homeSign = left ? -1 : 1;
  const zs = [-30, -22, -14, -6];
  const routeOrder = (left ? [0, 1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 0, 5, 6, 7, 4])
    .filter((_, routePosition) => routePosition % bot.ctf.teamSize === bot.ctf.teamIndex);
  for (const routeIndex of routeOrder) {
    if (stopping) break;
    const flagIndex = routeIndex < 4 ? routeIndex + 4 : routeIndex - 4;
    const z = zs[routeIndex % 4];
    const flagX = -homeSign * (flagIndex < 4 ? 18 : 10);
    const goalX = homeSign * (routeIndex < 4 ? 4 : 7);
    log(bot.username, `go flag ${flagX},${z}`);
    await goNear(bot, homeSign * 2, bot.entity.position.z);
    await goNear(bot, homeSign * 2, z + 0.3);
    await goNear(bot, flagX + homeSign * 0.8, z + 0.3, () => bot.ctf.carrying);
    await waitFor(bot, () => bot.ctf.carrying, `pickup at ${flagX},${z}`);
    if (stopping) break;
    log(bot.username, `go goal ${goalX},${z}`);
    const previousCaptures = bot.ctf.captures;
    await goNear(bot, goalX + 0.3, z + 0.3, () => bot.ctf.captures > previousCaptures);
    await waitFor(bot, () => bot.ctf.captures > previousCaptures, `capture at ${goalX},${z}`);
  }
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  clearTimeout(testTimeout);
  clearTimeout(finishTimer);
  const pickups = bots.reduce((total, bot) => total + bot.ctf.pickups, 0);
  const captures = bots.reduce((total, bot) => total + bot.ctf.captures, 0);
  const passed = gameEnded && pickups > 0 && captures > 0;
  process.exitCode = passed ? 0 : 1;
  log('smoke', `${passed ? 'PASS' : 'FAIL'}: pickups=${pickups}, captures=${captures}, gameEnded=${gameEnded}`);
  for (const bot of bots) {
    try { bot.clearControlStates(); bot.quit('local CTF smoke test finished'); } catch (_) {}
  }
}

const testTimeout = setTimeout(() => { log('smoke', 'test deadline exceeded'); stopAll(); }, 210000);
for (let i = 0; i < BOT_COUNT; i++) makeBot(i);
process.on('SIGINT', stopAll);

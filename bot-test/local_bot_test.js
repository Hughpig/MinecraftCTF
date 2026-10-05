const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const loopDiagnostics = require('./loop-diagnostics')();
const findArenaFlags = require('./arena-flag-search');
const waitForInitialWorld = require('./startup-world');

const HOST = process.env.CTF_HOST || '127.0.0.1';
const PORT = Number(process.env.CTF_PORT || 25565);
const BOT_COUNT = Math.max(1, Math.min(16, Number(process.env.CTF_BOTS || 2)));
const PLAYERS_PER_TEAM = Math.max(1, Math.min(16, Number(process.env.CTF_PLAYERS || 1)));
const ACTIVE_TEAM = process.env.CTF_ACTIVE_TEAM || 'both';
const VIEW_DISTANCE = Number(process.env.CTF_BOT_VIEW_DISTANCE ?? 3);
const JOIN_DELAY_MS = Number(process.env.CTF_BOT_JOIN_DELAY_MS ?? 400);
if (!Number.isInteger(VIEW_DISTANCE) || VIEW_DISTANCE < 2 || VIEW_DISTANCE > 32) throw new Error('CTF_BOT_VIEW_DISTANCE must be an integer between 2 and 32');
if (!Number.isFinite(JOIN_DELAY_MS) || JOIN_DELAY_MS < 0 || JOIN_DELAY_MS > 5000) throw new Error('CTF_BOT_JOIN_DELAY_MS must be between 0 and 5000');
const MATCH = `match team:local-bots enemy:bot players:${PLAYERS_PER_TEAM} map:fixed`;
const FLAG_APPROACH_OFFSET = 1.25;
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
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username, auth: 'offline', version: '1.21.8', viewDistance: VIEW_DISTANCE });
  bot.ctf = { index, team: null, started: false, routeRunning: false, routeFailed: false, carrying: false, jailed: false, pickups: 0, captures: 0 };

  bot.once('spawn', () => {
    log(username, `connected to ${HOST}:${PORT}`);
  });

  bot.on('messagestr', message => {
    log(username, message);
    if (message.includes('固定地图已生成：') || message.includes('固定地图已就绪：')) {
      confirmMapReady();
    }
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
          if (!bots.some(other => other.ctf.started)) {
            clearTimeout(testTimeout);
            testTimeout = setTimeout(() => { log('smoke', 'test deadline exceeded'); stopAll(); }, 210000);
          }
          bot.ctf.started = true;
          if (ACTIVE_TEAM === 'both' || ACTIVE_TEAM === bot.ctf.team) {
            runRoute(bot).catch(err => {
              bot.ctf.routeFailed = true;
              bot.clearControlStates();
              log(username, `route error; waiting for match end: ${err.stack || err}`);
            });
          }
        }
      } catch (err) {
        log(username, `cannot parse game start: ${err.message}`);
      }
    }
    if (message.includes('你携带了')) { bot.ctf.carrying = true; bot.ctf.pickups++; }
    if (message.includes('插旗成功！')) { bot.ctf.carrying = false; bot.ctf.captures++; }
    if (message.includes('旗已在附近重新立起')) bot.ctf.carrying = false;
    if (message.includes(`${username} 被抓捕并关入`) || (message.includes('你被 ') && message.includes('抓捕，监禁'))) {
      bot.ctf.jailed = true;
    }
    if (message.includes('监禁结束') || message.includes('已获释') || message.includes('监狱门已打开')) bot.ctf.jailed = false;
    if (message.includes('Game over!') && bot.ctf.started) {
      gameEnded = true;
      if (!finishTimer) finishTimer = setTimeout(stopAll, 200);
    }
  });

  bot.on('error', err => log(username, `error: ${err.message}`));
  bot.on('kicked', reason => log(username, `kicked: ${JSON.stringify(reason)}`));
  bot.on('end', reason => log(username, `disconnected: ${reason || 'unknown'}`));
  bots.push(bot);
  return bot;
}

async function goNear(bot, x, z, completed = () => false) {
  bot.clearControlStates();
  let started = Date.now();
  let lastLog = 0;
  let lastX = null;
  let lastZ = null;
  let lastProgress = Date.now();
  let nudgeUntil = 0;
  let nudgeLeft = false;
  const target = new Vec3(x, 64, z);
  while (!stopping && Date.now() - started < 20000) {
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
    if (distance <= 0.35 && Math.abs(position.y - target.y) < 2.0) { bot.clearControlStates(); return true; }
    if (lastX === null || Math.hypot(position.x - lastX, position.z - lastZ) > 0.12) {
      lastX = position.x;
      lastZ = position.z;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > 1200 && nudgeUntil < Date.now()) {
      nudgeLeft = !nudgeLeft;
      nudgeUntil = Date.now() + 550;
      lastProgress = Date.now();
    }
    await bot.lookAt(new Vec3(target.x, position.y + 1.62, target.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    bot.setControlState('left', nudgeUntil > Date.now() && nudgeLeft);
    bot.setControlState('right', nudgeUntil > Date.now() && !nudgeLeft);
    const ahead = bot.blockAt(position.offset(deltaX / Math.max(distance, 0.01) * 0.8, 0.1, deltaZ / Math.max(distance, 0.01) * 0.8));
    // Do not jump during the final approach to a flag/target. The server confirms
    // a pickup before the client reaches the block, so jumping here only makes the
    // bot brush the fence and appear to pause beside the flag.
    bot.setControlState('jump', distance > 1.2 && !!ahead && ahead.boundingBox === 'block');
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
  while (!stopping && !predicate() && Date.now() - started < 15000) await sleep(50);
  if (!stopping && !predicate()) throw new Error(`server did not confirm ${description}`);
}

function findEnemyFlag(bot, preferredX, preferredZ, homeSign) {
  const blockName = bot.ctf.team === 'left' ? 'blue_banner' : 'red_banner';
  const block = bot.registry.blocksByName[blockName];
  if (!block || !bot.entity) return null;
  const positions = findArenaFlags(bot, block.id);
  if (positions.length === 0) return null;
  positions.sort((a, b) => {
    const aPreferred = Math.hypot(a.x - preferredX, a.z - preferredZ);
    const bPreferred = Math.hypot(b.x - preferredX, b.z - preferredZ);
    const aDistance = a.distanceSquared(bot.entity.position);
    const bDistance = b.distanceSquared(bot.entity.position);
    return (aPreferred < 1 ? -10000 : aDistance) - (bPreferred < 1 ? -10000 : bDistance);
  });
  const position = positions[0];
  return { x: position.x + homeSign * FLAG_APPROACH_OFFSET, z: position.z + 0.3 };
}

async function waitForEnemyFlag(bot, preferredX, preferredZ, homeSign) {
  const started = Date.now();
  while (!stopping && Date.now() - started < 5000) {
    const flag = findEnemyFlag(bot, preferredX, preferredZ, homeSign);
    if (flag) return flag;
    await sleep(100);
  }
  throw new Error('cannot find an available enemy flag');
}

async function waitForRelease(bot) {
  const started = Date.now();
  while (!stopping && bot.ctf.jailed && Date.now() - started < 35000) await sleep(100);
  if (!stopping && bot.ctf.jailed) throw new Error('jail release was not confirmed');
}

async function leavePrison(bot) {
  if (!bot.entity) return;
  const inside = bot.entity.position.z >= 24 && bot.entity.position.z <= 32
    && Math.abs(bot.entity.position.x) >= 12 && Math.abs(bot.entity.position.x) <= 20;
  if (!inside) return;
  const doorX = bot.ctf.team === 'left' ? -15.5 : 16.5;
  await goNear(bot, doorX, 23.5);
}

async function patrolAfterRoute(bot) {
  const homeSign = bot.ctf.team === 'left' ? -1 : 1;
  const waypoints = [
    [homeSign * 2, -30], [homeSign * 2, -6],
    [homeSign * 8, -6], [homeSign * 8, -30]
  ];
  let index = 0;
  while (!stopping) {
    await waitForRelease(bot);
    await leavePrison(bot);
    const [x, z] = waypoints[index++ % waypoints.length];
    await goNear(bot, x, z);
  }
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
    let captured = false;
    let recoveringDroppedFlag = false;
    while (!stopping && !captured) {
      await waitForRelease(bot);
      await leavePrison(bot);
      const flag = recoveringDroppedFlag
        ? await waitForEnemyFlag(bot, flagX, z, homeSign)
        : { x: flagX + homeSign * FLAG_APPROACH_OFFSET, z: z + 0.3 };
      log(bot.username, `go flag ${flag.x.toFixed(1)},${flag.z.toFixed(1)}`);
      await goNear(bot, homeSign * 2, bot.entity.position.z);
      await goNear(bot, homeSign * 2, flag.z);
      await goNear(bot, flag.x, flag.z, () => bot.ctf.carrying);
      await waitFor(bot, () => bot.ctf.carrying, `pickup near ${flag.x.toFixed(1)},${flag.z.toFixed(1)}`);
      if (stopping) break;
      log(bot.username, `go goal ${goalX},${z}`);
      const previousCaptures = bot.ctf.captures;
      await goNear(bot, goalX + 0.3, z + 0.3, () => bot.ctf.captures > previousCaptures || !bot.ctf.carrying);
      captured = bot.ctf.captures > previousCaptures;
      recoveringDroppedFlag = !captured;
      if (recoveringDroppedFlag && !stopping) log(bot.username, 'flag lost after capture; retrying after release');
    }
  }
  // Keep the demo players visibly active after their assigned flags are gone.
  // Without this, a bot naturally stops at its last target and looks frozen.
  await patrolAfterRoute(bot);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  loopDiagnostics.stop();
  clearTimeout(testTimeout);
  clearTimeout(finishTimer);
  const pickups = bots.reduce((total, bot) => total + bot.ctf.pickups, 0);
  const captures = bots.reduce((total, bot) => total + bot.ctf.captures, 0);
  const routeFailures = bots.filter(bot => bot.ctf.routeFailed).length;
  const passed = gameEnded && pickups > 0 && captures > 0;
  process.exitCode = passed ? 0 : 1;
  log('smoke', `${passed ? 'PASS' : 'FAIL'}: pickups=${pickups}, captures=${captures}, routeFailures=${routeFailures}, gameEnded=${gameEnded}`);
  for (const bot of bots) {
    try { bot.clearControlStates(); bot.quit('local CTF smoke test finished'); } catch (_) {}
  }
}

let testTimeout = setTimeout(() => { log('smoke', 'startup deadline exceeded'); stopAll(); }, 120000);
async function startBots() {
  for (let i = 0; i < BOT_COUNT && !stopping; i++) {
    const bot = makeBot(i);
    await waitForInitialWorld(bot, { isStopping: () => stopping });
    if (stopping) return;
    log(bot.username, 'startup terrain loaded');
    if (i === 0) {
      bot.chat('/ctf setup');
      await mapReady;
    }
    if (i + 1 < BOT_COUNT) await sleep(JOIN_DELAY_MS);
  }
  await sleep(2000);
  for (const bot of bots) {
    if (stopping) return;
    bot.chat(MATCH);
    await sleep(100);
  }
}
startBots().catch(error => { log('smoke', error.stack || error); stopAll(); });
process.on('SIGINT', stopAll);

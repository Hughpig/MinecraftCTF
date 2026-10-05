const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const loopDiagnostics = require('./loop-diagnostics')();
const findArenaFlags = require('./arena-flag-search');
const findArenaGoals = require('./arena-goal-search');
const waitForInitialWorld = require('./startup-world');
const { planSteer, strafeSideForAway, makeBlockProbe, nearestFreeCell } = require('./ctf-steer');

const HOST = process.env.CTF_HOST || '127.0.0.1';
const PORT = Number(process.env.CTF_PORT || 25565);
const BOT_COUNT = Math.max(1, Math.min(16, Number(process.env.CTF_BOTS || 6)));
const PLAYERS_PER_TEAM = Math.max(1, Math.min(16, Number(process.env.CTF_PLAYERS || 3)));
const TEAM_SIDE = (process.env.CTF_TEAM_SIDE || '').toLowerCase();
const ACTIVE_TEAMS = TEAM_SIDE || process.env.CTF_ACTIVE_TEAM || 'both';
const NAME_PREFIX = process.env.CTF_NAME_PREFIX || 'LocalCTF';
const MAP_MODE = process.env.CTF_MAP_MODE || 'fixed';
const MATCH_EXTRA = (process.env.CTF_MATCH_EXTRA || '').trim();
const ENEMY = process.env.CTF_ENEMY || 'bot';
const SEND_SETUP = process.env.CTF_SETUP !== '0';
const VIEW_DISTANCE = Number(process.env.CTF_BOT_VIEW_DISTANCE ?? 3);
const LOGIN_STAGGER_MS = Number(process.env.CTF_BOT_LOGIN_STAGGER_MS ?? 250);
if (!Number.isInteger(VIEW_DISTANCE) || VIEW_DISTANCE < 2 || VIEW_DISTANCE > 32) throw new Error('CTF_BOT_VIEW_DISTANCE must be an integer between 2 and 32');
if (!Number.isFinite(LOGIN_STAGGER_MS) || LOGIN_STAGGER_MS < 0 || LOGIN_STAGGER_MS > 5000) throw new Error('CTF_BOT_LOGIN_STAGGER_MS must be between 0 and 5000');
const MATCH = `match team:${NAME_PREFIX.toLowerCase()} enemy:${ENEMY} players:${PLAYERS_PER_TEAM} map:${MAP_MODE}${MATCH_EXTRA ? ' ' + MATCH_EXTRA : ''}`;
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
  const username = `${NAME_PREFIX}_${index + 1}`;
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username, auth: 'offline', version: '1.21.8', viewDistance: VIEW_DISTANCE });
  bot.ctf = { index, team: null, started: false, routeRunning: false, routeFailed: false, carrying: false, jailed: false, pickups: 0, captures: 0, opponents: new Set() };

  bot.once('spawn', () => {
    log(username, `connected to ${HOST}:${PORT}`);
  });

  bot.on('messagestr', message => {
    log(username, message);
    if (message.includes('地图已生成：') || message.includes('地图已就绪：')) {
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
          bot.ctf.role = bot.ctf.teamIndex === 0 ? 'defender' : 'attacker';
          bot.ctf.opponents = new Set(teams[bot.ctf.team === 'left' ? 'right' : 'left']);
        }
        if (bot.ctf.team && !bot.ctf.started) {
          if (!bots.some(other => other.ctf.started)) {
            clearTimeout(testTimeout);
            testTimeout = setTimeout(() => { log('smoke', 'test deadline exceeded'); stopAll(); }, 210000);
          }
          bot.ctf.started = true;
          if (ACTIVE_TEAMS === 'both' || ACTIVE_TEAMS === bot.ctf.team) {
            runSmartRoute(bot).catch(async err => {
              bot.ctf.routeFailed = true;
              bot.clearControlStates();
              log(username, `route error; starting recovery: ${err.stack || err}`);
              await recoverRoute(bot);
            });
          }
          log(username, `smart role=${bot.ctf.role} teamIndex=${bot.ctf.teamIndex}`);
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

function nearestOpponent(bot, position, maxDistance = 3.5) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const entity of Object.values(bot.entities || {})) {
    if (entity.type !== 'player' || !entity.username || !bot.ctf.opponents.has(entity.username)) continue;
    const distance = Math.hypot(entity.position.x - position.x, entity.position.z - position.z);
    if (distance < nearestDistance && Math.abs(entity.position.y - position.y) <= 2.5) {
      nearest = entity;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function entityByUsername(bot, username) {
  return Object.values(bot.entities || {}).find(entity => entity.type === 'player' && entity.username === username) || null;
}

function homeSign(bot) {
  return bot.ctf.team === 'left' ? -1 : 1;
}

function isHomeHalf(bot, position) {
  return !!position && position.x * homeSign(bot) > 1;
}

function nearestHomeOpponent(bot, maxDistance = 96) {
  if (!bot.entity || !bot.ctf.team) return null;
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const entity of Object.values(bot.entities || {})) {
    if (entity.type !== 'player' || !entity.username || !bot.ctf.opponents.has(entity.username)) continue;
    if (!isHomeHalf(bot, entity.position)) continue;
    const distance = Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z);
    if (distance < nearestDistance && Math.abs(entity.position.y - bot.entity.position.y) <= 2.5) {
      nearest = entity;
      nearestDistance = distance;
    }
  }
  return nearest;
}

async function goNear(bot, x, z, completed = () => false, options = {}) {
  bot.clearControlStates();
  let started = Date.now();
  let lastLog = 0;
  let lastX = null;
  let lastZ = null;
  let lastProgress = Date.now();
  let nudgeUntil = 0;
  let nudgeLeft = false;
  let dodgeUntil = 0;
  let dodgeLeft = false;
  let dodgingOpponent = '';
  let detour = null;
  let stallCount = 0;
  let unstickUntil = 0;
  let unstickPoint = null;
  const maxDuration = options.maxDuration || 20000;
  const dodgePlayers = options.dodgePlayers !== false;
  const noDetour = options.noDetour === true;
  const target = new Vec3(x, 64, z);
  const probe = makeBlockProbe(bot);
  while (!stopping && Date.now() - started < maxDuration) {
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
    if (noDetour) detour = null;
    if (lastX === null || Math.hypot(position.x - lastX, position.z - lastZ) > 0.12) {
      lastX = position.x;
      lastZ = position.z;
      lastProgress = Date.now();
      stallCount = 0;
    } else if (Date.now() - lastProgress > 1200 && nudgeUntil < Date.now()) {
      stallCount++;
      nudgeLeft = !nudgeLeft;
      nudgeUntil = Date.now() + 550;
      lastProgress = Date.now();
      // Wedged in a corner between clusters: alternating strafes cannot help.
      // Walk backwards briefly to leave the pocket, then re-plan fresh.
      if (stallCount >= 2 && unstickUntil < Date.now()) {
        const steerLen = Math.hypot(deltaX, deltaZ) || 1;
        unstickPoint = { x: position.x - deltaX / steerLen * 1.6, z: position.z - deltaZ / steerLen * 1.6 };
        unstickUntil = Date.now() + 1200;
        detour = null;
        stallCount = 0;
      }
    }
    let steerPoint;
    if (unstickUntil > Date.now() && unstickPoint) {
      steerPoint = unstickPoint;
    } else {
      const steer = planSteer({ position, target, detour, probe });
      detour = steer.detour;
      steerPoint = steer.steerPoint;
    }
    const steerDeltaX = steerPoint.x - position.x;
    const steerDeltaZ = steerPoint.z - position.z;
    const steerDistance = Math.hypot(steerDeltaX, steerDeltaZ) || 1;
    // While carrying or deep in the enemy half the bot flees jailers from
    // further away and commits to the sidestep longer.
    const fleeing = bot.ctf.carrying || !isHomeHalf(bot, position);
    const opponent = dodgePlayers ? nearestOpponent(bot, position, fleeing ? 4.5 : 3.5) : null;
    if (opponent && (opponent.username !== dodgingOpponent || dodgeUntil <= Date.now())) {
      dodgingOpponent = opponent.username;
      const away = { x: position.x - opponent.position.x, z: position.z - opponent.position.z };
      const awayLen = Math.hypot(away.x, away.z) || 1;
      const side = strafeSideForAway(
        { x: steerDeltaX / steerDistance, z: steerDeltaZ / steerDistance },
        { x: away.x / awayLen, z: away.z / awayLen }
      );
      dodgeLeft = side ? side === 'left' : (Math.floor(position.x * 10) + Math.floor(position.z * 10) + opponent.username.length) % 2 === 0;
      dodgeUntil = Date.now() + (fleeing ? 700 : 550);
    }
    await bot.lookAt(new Vec3(steerPoint.x, position.y + 1.62, steerPoint.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    const dodging = dodgeUntil > Date.now();
    bot.setControlState('left', dodging ? dodgeLeft : nudgeUntil > Date.now() && nudgeLeft);
    bot.setControlState('right', dodging ? !dodgeLeft : nudgeUntil > Date.now() && !nudgeLeft);
    const ahead = bot.blockAt(position.offset(steerDeltaX / steerDistance * 0.8, 0.1, steerDeltaZ / steerDistance * 0.8));
    // Do not jump during the final approach to a flag/target. The server confirms
    // a pickup before the client reaches the block, so jumping here only makes the
    // bot brush the fence and appear to pause beside the flag. While detouring
    // around a two-high tree, jumping cannot help and only stalls the sidestep.
    bot.setControlState('jump', !detour && distance > 1.2 && !!ahead && ahead.boundingBox === 'block');
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

function scanEnemyBanners(bot) {
  const blockName = bot.ctf.team === 'left' ? 'blue_banner' : 'red_banner';
  const block = bot.registry.blocksByName[blockName];
  if (!block || !bot.entity) return null;
  const now = Date.now();
  if (bot.ctf.flagScan && now - bot.ctf.flagScan.at < 700) return bot.ctf.flagScan.positions;
  bot.ctf.flagScan = { at: now, positions: findArenaFlags(bot, block.id) };
  return bot.ctf.flagScan.positions;
}

function isBannerGone(bot, position) {
  const positions = scanEnemyBanners(bot);
  if (!positions) return false;
  return !positions.some(p => Math.abs(p.x - position.x) < 0.6 && Math.abs(p.z - position.z) < 0.6);
}

function findEnemyFlag(bot, preferredX, preferredZ, homeSign, attempt = 0) {
  const positions = scanEnemyBanners(bot);
  if (!positions || positions.length === 0) return null;
  const sorted = [...positions].sort((a, b) => {
    const aPreferred = Math.hypot(a.x - preferredX, a.z - preferredZ);
    const bPreferred = Math.hypot(b.x - preferredX, b.z - preferredZ);
    const aDistance = a.distanceSquared(bot.entity.position);
    const bDistance = b.distanceSquared(bot.entity.position);
    return (aPreferred < 1 ? -10000 : aDistance) - (bPreferred < 1 ? -10000 : bDistance);
  });
  // Rotate through the nearest few banners on retries: when a teammate grabs
  // the same nearest flag, the loser moves to the next one instead of racing
  // for the same spot again.
  const position = sorted[attempt % Math.min(sorted.length, 4)];
  // x/z is the approach point (offset toward home); bx/bz is the banner cell
  // itself, which is what "the flag is gone" checks must compare against.
  return { x: position.x + homeSign * FLAG_APPROACH_OFFSET, z: position.z + 0.3, bx: position.x, bz: position.z };
}

async function waitForEnemyFlag(bot, preferredX, preferredZ, homeSign, attempt = 0) {
  const started = Date.now();
  while (!stopping && Date.now() - started < 5000) {
    const flag = findEnemyFlag(bot, preferredX, preferredZ, homeSign, attempt);
    if (flag) return flag;
    await sleep(100);
  }
  throw new Error('cannot find an available enemy flag');
}

function isGoalLocked(bot, goal) {
  return bot.world.getBlockType(new Vec3(goal.x, 64, goal.z)) !== 0;
}

// Nearest unlocked home goal. Random stand layouts put goals anywhere, so
// hardcoding the legacy rows made carriers circle around empty coordinates.
async function waitForHomeGoal(bot) {
  const started = Date.now();
  let walked = false;
  while (!stopping && Date.now() - started < 20000) {
    const goals = findArenaGoals(bot);
    if (goals.length > 0 && bot.entity) {
      goals.sort((a, b) => a.distanceSquared(bot.entity.position) - b.distanceSquared(bot.entity.position));
      return goals[0];
    }
    // From the far enemy side the home goals sit outside the loaded chunks
    // and the scan comes up empty; walk toward home until one scrolls in
    // instead of standing still as capture bait.
    if (!walked && bot.entity) {
      walked = true;
      await goNear(bot, homeSign(bot) * 2, bot.entity.position.z,
        () => findArenaGoals(bot).length > 0, { maxDuration: 8000 });
    }
    await sleep(100);
  }
  throw new Error('cannot find an unlocked home goal');
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
  // Never detour or dodge inside the prison ring: a fresh jail can close the
  // door and a camper can trigger dodges that wedge the bot into the wall
  // corner. Push along the doorway axis instead — the plate or the 30s timer
  // opens the door, and the retry loop rides out the wait.
  for (let attempt = 0; attempt < 6 && !stopping; attempt++) {
    await goNear(bot, doorX, 26.4, () => false, { noDetour: true, dodgePlayers: false, maxDuration: 9000 });
    const outside = await goNear(bot, doorX, 23.5, () => false, { noDetour: true, dodgePlayers: false, maxDuration: 15000 })
      .then(() => true)
      .catch(() => false);
    if (outside) return;
  }
}

async function chaseHomeOpponent(bot, options = {}) {
  const chaseDeadline = Date.now() + (options.maxMs || Infinity);
  let lastTarget = '';
  while (!stopping && !bot.ctf.jailed && Date.now() < chaseDeadline) {
    const opponent = nearestHomeOpponent(bot);
    if (!opponent) return;
    if (opponent.username !== lastTarget) {
      lastTarget = opponent.username;
      log(bot.username, `defend chase ${opponent.username}`);
    }
    const targetId = opponent.entityId;
    try {
      await goNear(bot, opponent.position.x, opponent.position.z, () => {
        const current = entityByUsername(bot, opponent.username);
        return !current || current.entityId !== targetId || !isHomeHalf(bot, current.position) || bot.ctf.jailed;
      }, { dodgePlayers: false, maxDuration: 3000 });
    } catch (_) {
      bot.clearControlStates();
      await sleep(100);
    }
  }
}

async function patrolAfterRoute(bot) {
  const homeSign = bot.ctf.team === 'left' ? -1 : 1;
  const waypoints = [
    [homeSign * 2, -30], [homeSign * 2, -6],
    [homeSign * 8, -6], [homeSign * 8, -30]
  ];
  const probe = makeBlockProbe(bot);
  let index = 0;
  while (!stopping) {
    await waitForRelease(bot);
    await leavePrison(bot);
    // Hardcoded waypoints can end up inside a random tree; aim at the nearest
    // free cell instead of pushing into the trunk forever.
    const [x, z] = waypoints[index++ % waypoints.length];
    const free = nearestFreeCell(probe, x, z);
    await goNear(bot, free.x, free.z, () => !!nearestHomeOpponent(bot));
    if (nearestHomeOpponent(bot)) await chaseHomeOpponent(bot);
  }
}

async function runDefenderRoute(bot) {
  const sign = homeSign(bot);
  const waypoints = [
    [sign * 8, -30], [sign * 8, -6],
    [sign * 3, -6], [sign * 3, -30]
  ];
  const probe = makeBlockProbe(bot);
  let index = 0;
  while (!stopping) {
    await waitForRelease(bot);
    await leavePrison(bot);
    const [x, z] = waypoints[index++ % waypoints.length];
    const free = nearestFreeCell(probe, x, z);
    await goNear(bot, free.x, free.z, () => !!nearestHomeOpponent(bot));
    if (nearestHomeOpponent(bot)) await chaseHomeOpponent(bot);
  }
}

async function recoverRoute(bot) {
  if (stopping) return;
  try {
    await waitForRelease(bot);
    await leavePrison(bot);
    const sign = homeSign(bot);
    const currentZ = bot.entity ? Math.max(-30, Math.min(30, bot.entity.position.z)) : 0;
    const recoveryPoints = [
      [sign * 2, currentZ],
      [sign * 2, -30],
      [sign * 2, -6],
      [sign * 4, -30],
      [sign * 4, -6]
    ];
    for (const [x, z] of recoveryPoints) {
      if (stopping || !bot.entity || isHomeHalf(bot, bot.entity.position)) break;
      try { await goNear(bot, x, z, () => false, { maxDuration: 7000 }); } catch (_) { bot.clearControlStates(); }
    }
    if (!stopping) await patrolAfterRoute(bot);
  } catch (recoveryError) {
    bot.clearControlStates();
    log(bot.username, `recovery error: ${recoveryError.stack || recoveryError}`);
  }
}

async function runAttackerRoute(bot) {
  if (bot.ctf.routeRunning) return;
  bot.ctf.routeRunning = true;
  const left = bot.ctf.team === 'left';
  const homeSign = left ? -1 : 1;
  const zs = [-30, -22, -14, -6];
  const fullRoute = left ? [0, 1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 0, 5, 6, 7, 4];
  const attackerIndex = Math.max(0, bot.ctf.teamIndex - 1);
  const attackerCount = Math.max(1, bot.ctf.teamSize - 1);
  const routeOrder = fullRoute.filter((_, routePosition) => routePosition % attackerCount === attackerIndex);
  for (const routeIndex of routeOrder) {
    if (stopping) break;
    const flagIndex = routeIndex < 4 ? routeIndex + 4 : routeIndex - 4;
    const z = zs[routeIndex % 4];
    const flagX = -homeSign * (flagIndex < 4 ? 18 : 10);
    let captured = false;
    let attempts = 0;
    while (!stopping && !captured && attempts < 4) {
      attempts++;
      let flag = null;
      try {
        await waitForRelease(bot);
        await leavePrison(bot);
        // Attackers do not ignore intruders at home: while not carrying and an
        // opponent is close in our half, spend a short burst chasing before
        // continuing the flag route. Defenders keep the unlimited chase.
        if (!bot.ctf.carrying && nearestHomeOpponent(bot, 6)) {
          log(bot.username, 'opportunistic chase at home');
          await chaseHomeOpponent(bot, { maxMs: 6000 });
        }
        // Always locate the live banner. A teammate may have moved or dropped
        // it, so a hard-coded origin can leave this bot waiting beside empty air.
        flag = await waitForEnemyFlag(bot, flagX, z, homeSign, attempts - 1);
        log(bot.username, `go flag ${flag.x.toFixed(1)},${flag.z.toFixed(1)}`);
        await goNear(bot, homeSign * 2, bot.entity.position.z);
        await goNear(bot, homeSign * 2, flag.z);
        // If a teammate grabs this banner first it vanishes from the world —
        // bail out immediately and let the retry pick the next nearest flag
        // instead of walking to an empty spot for the full timeout.
        const flagTarget = { x: flag.bx, z: flag.bz };
        await goNear(bot, flag.x, flag.z, () => bot.ctf.carrying || isBannerGone(bot, flagTarget));
        // The banner can vanish (a teammate or opponent grabs it) between
        // arrival and the server's pickup confirm; without a live check the
        // bot would stand here as capture bait for the whole 15s timeout.
        await waitFor(bot, () => bot.ctf.carrying || isBannerGone(bot, flagTarget), `pickup near ${flag.x.toFixed(1)},${flag.z.toFixed(1)}`);
        if (!bot.ctf.carrying) throw new Error('flag vanished before pickup');
        await waitFor(bot, () => bot.ctf.carrying, `pickup near ${flag.x.toFixed(1)},${flag.z.toFixed(1)}`);
        if (stopping) break;
        const goal = await waitForHomeGoal(bot);
        log(bot.username, `go goal ${goal.x},${goal.z}`);
        const previousCaptures = bot.ctf.captures;
        const goalTarget = { x: goal.x, z: goal.z };
        await goNear(bot, goal.x + homeSign * 0.3, goal.z + 0.3,
          () => bot.ctf.captures > previousCaptures || !bot.ctf.carrying || isGoalLocked(bot, goalTarget));
        captured = bot.ctf.captures > previousCaptures;
        if (!captured && !stopping) log(bot.username, 'flag lost after capture; retrying after release');
      } catch (err) {
        if (stopping) break;
        bot.clearControlStates();
        // If the bot was interrupted after pickup, get it back toward its own
        // half before trying the live flag scan again.
        if (bot.ctf.carrying) {
          try {
            const goal = await waitForHomeGoal(bot);
            await goNear(bot, goal.x + homeSign * 0.3, goal.z + 0.3, () => !bot.ctf.carrying, { maxDuration: 10000 });
          } catch (_) { bot.clearControlStates(); }
        }
        log(bot.username, `route step ${attempts}/4 skipped; retrying live flag: ${err.message}`);
        await sleep(250);
      }
    }
    if (!captured && !stopping) log(bot.username, `route target ${routeIndex} skipped after ${attempts} attempts`);
  }
  // Keep the demo players visibly active after their assigned flags are gone.
  // Without this, a bot naturally stops at its last target and looks frozen.
  await patrolAfterRoute(bot);
}

async function runSmartRoute(bot) {
  log(bot.username, `walk-smart role=${bot.ctf.role}`);
  if (bot.ctf.role === 'defender') return runDefenderRoute(bot);
  return runAttackerRoute(bot);
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
  // Three chunks cover the route's flags from the prison exit. Two can leave
  // the far banners unloaded when a released bot scans for its next target.
  // Logins only need a small stagger: Paper paces chunk sends per player, so
  // the terrain waits run in parallel instead of one bot gating the next.
  const terrainReady = [];
  for (let i = 0; i < BOT_COUNT && !stopping; i++) {
    const bot = makeBot(i);
    terrainReady.push(
      waitForInitialWorld(bot, { isStopping: () => stopping })
        .then(() => log(bot.username, 'startup terrain loaded'))
    );
    if (i === 0 && SEND_SETUP) {
      // The map is restored from the built arena at plugin enable, so setup
      // only needs a spawned player, not fully streamed terrain.
      bot.once('spawn', () => { if (!stopping) bot.chat('/ctf setup'); });
    }
    if (i + 1 < BOT_COUNT) await sleep(LOGIN_STAGGER_MS);
  }
  if (stopping) return;
  await Promise.all(terrainReady);
  if (stopping) return;
  // Only the setup-sending group waits for the map broadcast; other groups can
  // miss it (they log in after it fired), and match start handles the map itself.
  if (SEND_SETUP) await mapReady;
  // Let Paper settle the last login before match preparation/teleports begin.
  await sleep(2000);
  if (TEAM_SIDE) {
    // Pinned side (launcher mixed teams): join explicitly so the match message
    // does not rely on server auto-balancing.
    for (const bot of bots) {
      if (stopping) return;
      bot.chat(`/ctf join ${TEAM_SIDE}`);
      await sleep(150);
    }
  }
  for (const bot of bots) {
    if (stopping) return;
    bot.chat(MATCH);
    await sleep(100);
  }
}
startBots().catch(error => { log('smoke', error.stack || error); stopAll(); });
process.on('SIGINT', stopAll);

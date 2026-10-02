// ==========================================
// 段错误队 - CTF 终极决战版 (v8.1)
// 特性: 障碍物膨胀防卡墙 / 物理非对称脱困 / 极速寻路 / 完美越狱
// 修复: 解决了 gameLoop 中逻辑块闭合异常导致的语法错误
// ==========================================

process.on('uncaughtException', (err) => {
  console.error('💥 捕获到致命错误:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🌐 未处理的异步拒绝:', reason);
});

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear } = goals;
const { Vec3 } = require("vec3");
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// 命令行参数
const role = process.argv[2] || "Striker";
const username = process.argv[3] || "Hughpig_0";
const botId = username.includes('_') ? parseInt(username.split('_')[1]) : 0;

// 房间配置
const TEAM_NUM = 608;
const AGAINST_TEAM = "bot";
const PER_TEAM_PLAYER = 3;
const MAP_MODE = "random"; 

// 状态变量
let gameStart = false;
let isRunning = false;
let myTeam = null;
let homeBanner = null;
let enemyBanner = null;
let lastBotPos = null;
let stuckTimer = 0;
let tankStuckCounter = 0; 
let tankCooldown = 0;     
let lockedFlagPos = null;
let lockedHomePos = null;    
let lockedThreatName = null; 
let threatLockExpiry = 0;    
let rescuePlateTimer = 0;
let escapeCooldown = 0;
const localBadBlocks = [];

// --- B-Hop 共享状态 ---
let targetVec = null;
let bhopEnabled = false;

// --- 开局同步与扫描变量 ---
let gameStartTime = 0;
let isMapReady = false;
const badBlocks = new Set();
let globalPrisonPlate = null;

// 日志系统
const logFileName = "log_" + username + "_" + new Date().toISOString().replace(/[:.]/g, '-') + ".txt";
const logFilePath = path.join(__dirname, 'logs', logFileName);
if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'));
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

function logT(msg) {
  const time = new Date().toTimeString().split(' ')[0];
  const formattedMsg = "[" + time + "] " + msg;
  console.log(formattedMsg);
  logStream.write(formattedMsg + '\n');
}

const bot = mineflayer.createBot({
  host: '61.169.223.171',
  username: username,
});
bot.loadPlugin(pathfinder);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 0. 物理引擎 hook (B-Hop 核心)
// ==========================================
bot.on('physicsTick', () => {
  if (!bhopEnabled || !bot.entity || !bot.entity.onGround || !targetVec) return;
  if (isHeadingTowardsGoal(targetVec)) {
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    // 脉冲式跳跃：由 physicsTick 频率决定，每 tick 探测是否需要起跳
    // pathfinder 会在它自己的 tick 里重置控制，所以我们在这里强制覆盖
  }
});

// ==========================================
// 1. 网络与情报共享层 (UDP)
// ==========================================
const messagePort = 11451;
const server = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');

server.bind(messagePort, '127.0.0.1', () => { server.setBroadcast(true); });

server.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data.sender === bot.username) return;

    if (data.type === 'SCAN_COMPLETE') {
      if (!isMapReady) {
        isMapReady = true;
        logT("[战术] 收到全场扫描完成信号，解除出击限制！");
      }
    }

    if (data.type === 'BULK_BAD_BLOCKS') {
      data.list.forEach(p => {
        const key = Math.floor(p.x) + "," + Math.floor(p.z);
        badBlocks.add(key);
      });
    }
  } catch (e) { }
});

async function scanSurroundings() {
  logT("🛰️ 正在执行【非阻塞降维扫描】...");

  const mobPositions = Object.values(bot.entities)
    .filter(e => e && (e.type === 'mob' || e.type === 'animal') && e.position)
    .map(e => ({ x: e.position.x, z: e.position.z }));

  let addedCount = 0;
  const bulkList = [];

  const allBlocks = bot.findBlocks({
    matching: (b) => b.name !== 'air',
    maxDistance: 80,
    count: 10000
  });

  for (let i = 0; i < allBlocks.length; i++) {
    const pos = allBlocks[i];
    if (i % 500 === 0) await wait(10); 

    if (pos.y <= 0 || pos.y >= 3) continue;

    let isMob = false;
    for (const mp of mobPositions) {
      if (Math.pow(mp.x - pos.x, 2) + Math.pow(mp.z - pos.z, 2) < 1.44) {
        isMob = true;
        break;
      }
    }
    if (isMob) continue;

    const b = bot.blockAt(pos);
    if (!b || b.boundingBox !== 'block') continue;

    const n = b.name.toLowerCase();
    if (n.includes('mooshroom') || n.includes('cow') || n.includes('sheep')) continue;

    const qX = Math.floor(pos.x);
    const qZ = Math.floor(pos.z);
    const key = qX + "," + qZ;

    if (!badBlocks.has(key)) {
      badBlocks.add(key);
      bulkList.push({ x: qX, z: qZ });
      addedCount++;
    }
  }

  const plate = bot.findBlock({ matching: b => b.name.includes('pressure_plate'), maxDistance: 50 });
  if (plate) globalPrisonPlate = plate.position.clone().offset(0.5, 0, 0.5);

  printRadar();

  if (bulkList.length > 0) {
    client.send(JSON.stringify({ type: 'BULK_BAD_BLOCKS', sender: bot.username, list: bulkList }), messagePort, '127.0.0.1');
  }

  isMapReady = true;
  client.send(JSON.stringify({ type: 'SCAN_COMPLETE', sender: bot.username }), messagePort, '127.0.0.1');
  logT("✅ 扫描完成！墙体死点：" + badBlocks.size + " (新增: " + addedCount + ")");
}

function printRadar() {
  if (badBlocks.size === 0) return; 
  const botX = Math.floor(bot.entity.position.x);
  const botZ = Math.floor(bot.entity.position.z);
  logT("\n🗺️ ===== 实时 2D 雷达 (半径 15 格) =====");

  let mapLines = [];
  for (let z = botZ - 15; z <= botZ + 15; z++) {
    let rowStr = "";
    for (let x = botX - 15; x <= botX + 15; x++) {
      if (x === botX && z === botZ) {
        rowStr += "@@";
      } else {
        const key = x + "," + z;
        rowStr += badBlocks.has(key) ? "██" : "  ";
      }
    }
    mapLines.push(rowStr);
  }
  console.log(mapLines.join("\n"));
  logT("🗺️ ===========================================\n");
}

function findBlocksByName(name, maxDistance = 95) {
  const block = bot.registry.blocksByName[name];
  if (!block) return [];
  const found = bot.findBlocks({ matching: block.id, maxDistance, count: 32 });
  return found.map(p => [p.x, p.y, p.z]);
}

function carryingEnemyFlag() {
  if (!enemyBanner || !bot.entity) return false;
  if (bot.entity.equipment) {
    for (const item of bot.entity.equipment) { if (item && item.name === enemyBanner) return true; }
  }
  if (bot.inventory && bot.inventory.slots) {
    for (const item of bot.inventory.slots) { if (item && item.name === enemyBanner) return true; }
  }
  return false;
}

let _cachedBannerPos = null;
let _bannerCacheTime = 0;
const BANNER_CACHE_MS = 500;

function getCachedBanners() {
  if (!enemyBanner) return [];
  if (Date.now() - _bannerCacheTime > BANNER_CACHE_MS) {
    _cachedBannerPos = findBlocksByName(enemyBanner);
    _bannerCacheTime = Date.now();
  }
  return _cachedBannerPos;
}

function findEnemyFlags() {
  const flags = [];
  for (const [x, y, z] of getCachedBanners()) {
    if (myTeam === "L" && x > 0) flags.push({ goal: [x, y - 1, z] });
    if (myTeam === "R" && x < 0) flags.push({ goal: [x, y - 1, z] });
  }
  return flags;
}

let cachedGoldBlocks = null;

function findHomeGoals() {
  const homes = [];
  if (!myTeam) return homes;
  const enemyFlagPositions = new Set(getCachedBanners().map(([x, y, z]) => x + "," + y + "," + z));

  if (!cachedGoldBlocks) {
    cachedGoldBlocks = findBlocksByName("gold_block");
  }

  for (const [x, y, z] of cachedGoldBlocks) {
    const hasEnemyFlagAbove = enemyFlagPositions.has(x + "," + (y + 2) + "," + z);
    if (myTeam === "L" && x < 0 && !hasEnemyFlagAbove) homes.push({ goal: [x, y + 1, z] });
    if (myTeam === "R" && x > 0 && !hasEnemyFlagAbove) homes.push({ goal: [x, y + 1, z] });
  }
  return homes;
}

function dist(goal) {
  if (!bot.entity) return 9999;
  const dx = bot.entity.position.x - goal[0];
  const dy = bot.entity.position.y - goal[1];
  const dz = bot.entity.position.z - goal[2];
  return dx * dx + dy * dy + dz * dz;
}

function exploreGoal() {
  const x = Math.round(bot.entity.position.x) + Math.floor(Math.random() * 33) - 16;
  const y = Math.round(bot.entity.position.y);
  const z = Math.round(bot.entity.position.z) + Math.floor(Math.random() * 33) - 16;
  return [x, y, z];
}

function isInMyHalf(pos) {
  if (!pos) return false;
  return myTeam === 'L' ? pos.x < 0 : pos.x > 0;
}

function isEnemy(entity) {
  if (!entity || entity.type !== 'player' || entity.username === bot.username) return false;
  const myPrefix = bot.username.split('_')[0];
  return !entity.username.startsWith(myPrefix);
}

function isTeammate(entity) {
  if (!entity || entity.type !== 'player' || entity.username === bot.username) return false;
  const myPrefix = bot.username.split('_')[0];
  return entity.username.startsWith(myPrefix);
}

function isPosInPrison(pos) {
  if (!pos) return false;
  const inPrisonZone = (pos.z >= 24 && pos.z <= 32) || (pos.z <= -32 && pos.z >= -24);
  const sideZone = Math.abs(pos.x) >= 12 && Math.abs(pos.x) <= 20;
  return inPrisonZone && sideZone;
}

function findTrappedTeammate() {
  const teammates = Object.values(bot.entities).filter(e => isTeammate(e));
  return teammates.find(t => isPosInPrison(t.position));
}

function isHeadingTowardsGoal(targetVec, threshold = 0.75) {
  if (!bot.entity) return false;
  const vel = bot.entity.velocity;
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (speed < 0.05) return true; // 静止时也允许跳，帮助起步加速
  
  const velDirX = vel.x / speed;
  const velDirZ = vel.z / speed;
  
  const pos = bot.entity.position;
  const toDX = targetVec.x - pos.x;
  const toDZ = targetVec.z - pos.z;
  const toLen = Math.sqrt(toDX * toDX + toDZ * toDZ);
  if (toLen < 1) return true; 
  
  const dot = (velDirX * (toDX / toLen)) + (velDirZ * (toDZ / toLen));
  return dot > threshold;
}

function getPredictedEnemyPos(enemy, lookAheadSeconds = 0.4) {
  if (!enemy || !enemy.position) return new Vec3(0, 0, 0);
  const pos = enemy.position;
  const vel = enemy.velocity;
  // 严格检查分量，确保不会产生 NaN 导致距离计算失效
  if (!vel || !Number.isFinite(vel.x) || !Number.isFinite(vel.z)) return pos.clone();
  
  return new Vec3(
    pos.x + vel.x * lookAheadSeconds * 20, 
    pos.y,
    pos.z + vel.z * lookAheadSeconds * 20
  );
}

async function gameLoop() {
  if (isRunning) return;
  isRunning = true;
  logT("==============================================");
  logT(">>> 战术引擎已就绪 | 阵营: " + myTeam + " | 目标: " + enemyBanner + " | 身份: " + role + " <<<");
  logT("==============================================");

  const movements = new Movements(bot);
  movements.allowSprinting = true;
  movements.canDig = false;
  movements.allow1by1towers = false; 
  movements.heuristicCostScale = 1.1;
  movements.allowEntityDetection = false; 
  movements.allowParkour = false;

  let currentTeammatePos = [];
  let currentEnemyPos = [];

  movements.exclusionAreas = (block) => {
    if (!block) return 0;
    const bp = block.position;
    const botPos = bot.entity.position;
    if (bp.distanceSquared(botPos) < 0.64) return 0;
    const qX = Math.floor(bp.x);
    const qZ = Math.floor(bp.z);
    const key = qX + "," + qZ;
    if (badBlocks.has(key)) return 100000; 
    let cost = 0;
    const isAnchor = ["Anchor", "Defender", "Supporter"].includes(role);
    if (isAnchor) {
      for (const ePos of currentEnemyPos) {
        const sqDist = ePos.distanceSquared(bp);
        if (sqDist < 25) { cost += 500; }
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (badBlocks.has((qX + dx) + "," + (qZ + dz))) cost += 5; 
    }
    return cost;
  };

  bot.pathfinder.setMovements(movements);

  let loopCount = 0;
  let lastScanTime = Date.now();
  let lastMode = "";
  let wasTankMode = false; 
  let wasSelfDefense = false; 
  const posHistory = [];
  let selfDefenseTimer = 0; // Anchor 专用：防止追敌人追到地图边界死卡

  while (gameStart) {
    if (!bot.entity) { await wait(1000); continue; }
    currentTeammatePos = Object.values(bot.entities).filter(e => isTeammate(e)).map(e => e.position);
    currentEnemyPos = Object.values(bot.entities).filter(e => isEnemy(e) && e.position).map(e => e.position);
    const now = Date.now();
    const gameAge = (now - gameStartTime) / 1000;
    const isAnchor = ["Anchor", "Defender", "Supporter"].includes(role);
    if (!isMapReady && gameAge < 4 && !isAnchor) {
      logT("⏳ 等待 Anchor 卫星图就绪 (已等待 " + gameAge.toFixed(1) + "s)...");
      await wait(1000);
      continue;
    }
    if (isAnchor && now - lastScanTime > 25000) { await scanSurroundings(); lastScanTime = now; }
    const currentPos = bot.entity.position;
    if (tankCooldown > 0) tankCooldown--; 
    const hasFlag = carryingEnemyFlag();
    if (!hasFlag) lockedHomePos = null;
    const enemyFlags = findEnemyFlags();
    const homeGoals = findHomeGoals();
    let delta = lastBotPos ? currentPos.distanceTo(lastBotPos) : 0;
    lastBotPos = currentPos.clone();
    let target = null, mode = "", range = 1.2;
    // targetVec 已提升至全局

    let isMeTrulyPrisoner = false;
    if (isPosInPrison(currentPos)) {
      if (delta > 8) isMeTrulyPrisoner = true;
      if (lastMode === "🚔 IN_PRISON") isMeTrulyPrisoner = true;
      if (gameAge < 3) isMeTrulyPrisoner = true;
    }

    if (isMeTrulyPrisoner) {
      bhopEnabled = false; // 监狱模式自己接管键盘，禁止 physicsTick 干扰
      mode = "🚔 IN_PRISON";
      bot.pathfinder.setGoal(null);
      const exitX = myTeam === 'L' ? -12 : 12;
      bot.lookAt(new Vec3(exitX, currentPos.y, currentPos.z));
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      const shimmy = (loopCount % 6 < 3);
      bot.setControlState('left', shimmy);
      bot.setControlState('right', !shimmy);
      const isSafeOut = myTeam === 'L' ? currentPos.x > -11 : currentPos.x < 11;
      if (delta > 0.5 && isSafeOut) {
        logT("🔓 彻底冲出监狱墙角雷区！切回战术模式。");
        isMeTrulyPrisoner = false;
        bot.clearControlStates();
      }
    }
    else if (!isAnchor) {
      if (hasFlag && homeGoals.length > 0) {
        if (!lockedHomePos) {
          lockedHomePos = homeGoals.reduce((best, item) => dist(item.goal) < dist(best.goal) ? item : best);
        } else {
          const stillThere = homeGoals.find(f => Math.abs(f.goal[0] - lockedHomePos.goal[0]) < 1 && Math.abs(f.goal[2] - lockedHomePos.goal[2]) < 1);
          const currentBest = homeGoals.reduce((best, item) => dist(item.goal) < dist(best.goal) ? item : best);
          if (!stillThere || (dist(lockedHomePos.goal) - dist(currentBest.goal) > 100)) { lockedHomePos = currentBest; }
        }
        target = lockedHomePos; mode = "🏆 RETURNING"; range = 0.5;
      } else if (enemyFlags.length > 0) {
        lockedHomePos = null; 
        if (!lockedFlagPos) {
          const sortedFlags = enemyFlags.sort((a, b) => dist(a.goal) - dist(b.goal));
          lockedFlagPos = sortedFlags[botId % sortedFlags.length];
        } else {
          const stillThere = enemyFlags.find(f => Math.abs(f.goal[0] - lockedFlagPos.goal[0]) < 1 && Math.abs(f.goal[2] - lockedFlagPos.goal[2]) < 1);
          if (!stillThere) {
            const sortedFlags = enemyFlags.sort((a, b) => dist(a.goal) - dist(b.goal));
            lockedFlagPos = sortedFlags[botId % sortedFlags.length];
          } else {
            const sortedFlags = enemyFlags.sort((a, b) => dist(a.goal) - dist(b.goal));
            const closestFlag = sortedFlags[0];
            if (dist(lockedFlagPos.goal) - dist(closestFlag.goal) > 225) { lockedFlagPos = closestFlag; }
          }
        }
        target = lockedFlagPos; mode = "⚔️ ATTACKING"; range = 1.0;
        const enemies = Object.values(bot.entities).filter(e => isEnemy(e) && e.position);
        const nearestThreat = enemies.length > 0 ? enemies.sort((a, b) => a.position.distanceSquared(currentPos) - b.position.distanceSquared(currentPos))[0] : null;
        if (nearestThreat) {
           const realDistSq = nearestThreat.position.distanceSquared(currentPos);
           if (realDistSq < 64) {
             const predicted = getPredictedEnemyPos(nearestThreat, 0.4);
             target = { goal: [predicted.x, predicted.y, predicted.z] };
             mode = "⚔️ SELF_DEFENSE"; range = 0.2;
             bot.lookAt(nearestThreat.position.offset(0, 1.6, 0), true);
             bot.attack(nearestThreat);
           }
        }
      }
    }
    else {
      const trappedTeammate = findTrappedTeammate();
      let nearestThreat = null;
      const enemies = Object.values(bot.entities).filter(e => isEnemy(e) && e.position);
      const intruders = enemies.filter(e => isInMyHalf(e.position));
      if (lockedThreatName && now < threatLockExpiry) {
        nearestThreat = enemies.find(e => e.username === lockedThreatName);
        if (!nearestThreat || nearestThreat.position.distanceSquared(currentPos) > 400) { lockedThreatName = null; nearestThreat = null; }
      }
      if (!nearestThreat && intruders.length > 0) {
        nearestThreat = intruders.sort((a, b) => a.position.distanceSquared(currentPos) - b.position.distanceSquared(currentPos))[0];
        if (nearestThreat) { lockedThreatName = nearestThreat.username; threatLockExpiry = now + 4000; }
      }
      if (nearestThreat) {
        const predicted = getPredictedEnemyPos(nearestThreat, 0.4);
        let goalX = predicted.x; let goalY = predicted.y; let goalZ = predicted.z;
        
        // 全局坐标限制：防止目标点超出地图边界 (约 ±48, ±33)
        goalX = Math.max(-48, Math.min(48, goalX));
        goalZ = Math.max(-33, Math.min(33, goalZ));

        const realDistSq = nearestThreat.position.distanceSquared(currentPos);
        if (realDistSq < 64) {
          bot.setControlState('sneak', false); mode = "⚔️ SELF_DEFENSE";
          bot.lookAt(nearestThreat.position.offset(0, 1.6, 0), true); bot.attack(nearestThreat);
          target = { goal: [goalX, goalY, goalZ] }; range = 0.2;
          selfDefenseTimer++;
          // 超时保护：3秒（30帧）追不到就放弃，回哨位，防止被风筝带出边界
          if (selfDefenseTimer > 30) {
            logT("⏱️ SELF_DEFENSE 超时，放弃追击，回哨位");
            selfDefenseTimer = 0;
            lockedThreatName = null; // 解除仇恨锁定
            threatLockExpiry = 0;
            mode = "🏰 GUARDING"; // 强制切回守卫
            const guardX = myTeam === 'L' ? -5.5 : 5.5;
            target = { goal: [guardX, currentPos.y, currentPos.z] }; range = 2.0;
          }
        } else {
          const myFlag = homeGoals[0] ? homeGoals[0].goal : null;
          if (myFlag) {
            const vecX = myFlag[0] - goalX; const vecZ = myFlag[2] - goalZ;
            const distToFlag = Math.sqrt(vecX * vecX + vecZ * vecZ);
            if (distToFlag > 5) { goalX += (vecX / distToFlag) * 4.0; goalZ += (vecZ / distToFlag) * 4.0; }
          }
          const midLineBuffer = myTeam === 'L' ? -2.5 : 2.5;
          if (myTeam === 'L' && goalX > midLineBuffer) goalX = midLineBuffer;
          if (myTeam === 'R' && goalX < midLineBuffer) goalX = midLineBuffer;
          // Z轴也限制在地图范围内，防止追出边界
          goalZ = Math.max(-33, Math.min(33, goalZ));
          target = { goal: [goalX, goalY, goalZ] }; mode = "🛡️ INTERCEPTING"; range = 1.0;
        }
      } else if (trappedTeammate && isInMyHalf(trappedTeammate.position)) {
        mode = "🚑 HARD_RESCUE";
        let pX = myTeam === 'L' ? -16.0 : 16.0; let pZ = trappedTeammate.position.z > 0 ? 28.5 : -28.5;
        if (globalPrisonPlate) { pX = globalPrisonPlate.x; pZ = globalPrisonPlate.z; }
        const targetP = new Vec3(pX, currentPos.y, pZ);
        if (currentPos.distanceSquared(targetP) < 0.8) {
          bot.pathfinder.setGoal(null); bot.clearControlStates();
          bot.lookAt(targetP.offset(myTeam === 'L' ? -0.5 : 0.5, 0, 0));
          mode = "⚓ ANCHOR_STATIONARY"; rescuePlateTimer++;
          if (rescuePlateTimer > 40) { rescuePlateTimer = 0; bot.setControlState('back', true); }
        } else { target = { goal: [pX, currentPos.y, pZ] }; range = 0.3; rescuePlateTimer = 0; }
      } else {
        mode = "🏰 GUARDING"; let aggroZ = 0;
        const allEnemies = Object.values(bot.entities).filter(e => isEnemy(e) && e.position);
        if (allEnemies.length > 0) {
          // Z轴跟随：用离中线最近（最危险）的敌人的Z坐标
          const nearestEnemy = allEnemies.sort((a, b) => Math.abs(a.position.x) - Math.abs(b.position.x))[0];
          aggroZ = Math.max(-33, Math.min(33, nearestEnemy.position.z));
        }
        // 守中线哨位（离中线5格），形成活人墙，不再去追金块点
        const guardX = myTeam === 'L' ? -5.5 : 5.5;
        target = { goal: [guardX, currentPos.y, aggroZ] }; range = 2.0;
      }
      if (!nearestThreat) { selfDefenseTimer = 0; } // 不在追击状态就重置计时器
      if (target && target.goal) {
        const hardLimitX = myTeam === 'L' ? -1.5 : 1.5;
        if (myTeam === 'L' && target.goal[0] > hardLimitX) target.goal[0] = hardLimitX;
        if (myTeam === 'R' && target.goal[0] < hardLimitX) target.goal[0] = hardLimitX;
      }
    }

    if (!target) { target = { goal: exploreGoal() }; mode = "🔍 EXPLORING"; range = 2.0; }
    targetVec = new Vec3(target.goal[0], target.goal[1], target.goal[2]);
    const d = Math.sqrt(dist(target.goal));
    const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    logT("[状态] " + mode + " | 坐标:[" + currentPos.x.toFixed(1) + ", " + currentPos.y.toFixed(1) + ", " + currentPos.z.toFixed(1) + "] | 距目标: " + d.toFixed(1) + "格 | 秒速: " + delta.toFixed(3) + "格 | 内存: " + memoryUsage + "MB");

    const noPathModes = ["🚔 IN_PRISON", "⚓ ANCHOR_STATIONARY", "⚔️ SELF_DEFENSE"];
    const isTankMode = mode === "⚔️ ATTACKING" && d < 1.8 && tankCooldown <= 0;
    const effectiveRange = (mode === "🏆 RETURNING" || mode === "⚔️ ATTACKING") ? 1.5 : range;
    const isSatisfied = d <= effectiveRange + 0.5;

    // Anchor 边界拦截：越过中线立刻强制归位（比 hardLimitX 更严格的物理保护）
    const isAnchorOverMidline = isAnchor && ((myTeam === 'L' && currentPos.x > 1.0) || (myTeam === 'R' && currentPos.x < -1.0));

    if (escapeCooldown > 0) {
      bhopEnabled = false;
      escapeCooldown--; if (escapeCooldown === 0) bot.clearControlStates();
    } else if (isAnchorOverMidline) {
       // Anchor 越界保护：强制切回 A* 归位
       bhopEnabled = false;
       const homeX = myTeam === 'L' ? -5 : 5;
       const p = new GoalNear(homeX, currentPos.y, currentPos.z, 1);
       bot.pathfinder.setGoal(p);
       mode = "🛡️ RECALLING";
    } else if (noPathModes.includes(mode)) {
      bhopEnabled = false;
      tankStuckCounter = 0; wasTankMode = false;
      if (mode === "⚔️ SELF_DEFENSE") {
        bot.pathfinder.setGoal(null); bot.setControlState('forward', true); bot.setControlState('sprint', true); wasSelfDefense = true;
        if (bot.entity.onGround) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 50); }
      } else { if (wasSelfDefense) { bot.clearControlStates(); wasSelfDefense = false; } }
    } else if (isTankMode) {
      bhopEnabled = false; // 坦克模式有自己的物理逻辑
      wasTankMode = true; if (wasSelfDefense) { bot.clearControlStates(); wasSelfDefense = false; }
      bot.pathfinder.setGoal(null); bot.lookAt(targetVec); bot.setControlState('forward', true); bot.setControlState('sprint', true);
      if (bot.entity.onGround && isHeadingTowardsGoal(targetVec)) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 50); }
      if (delta < 0.1) { tankStuckCounter++; if (tankStuckCounter > 6) { logT("🛡️ 坦克模式撞墙，强制冷却开启"); tankCooldown = 30; bot.clearControlStates(); } } else { tankStuckCounter = 0; }
    } else {
      bhopEnabled = true; // 启用 physicsTick B-Hop 覆盖 pathfinder 控制
      tankStuckCounter = 0; if (wasTankMode || wasSelfDefense) { bot.clearControlStates(); wasTankMode = false; wasSelfDefense = false; }
      const p = new GoalNear(target.goal[0], target.goal[1], target.goal[2], effectiveRange);
      bot.pathfinder.setGoal(p);
      // 原有的内部 jump 逻辑已移除，由外部 bhopEnabled 处理
    }

    if (!isTankMode && !noPathModes.includes(mode) && !isSatisfied && escapeCooldown === 0) {
      posHistory.push(currentPos.clone()); if (posHistory.length > 8) posHistory.shift(); 
      if (posHistory.length === 4) {
        const dist4 = posHistory[0].distanceTo(currentPos);
        if (dist4 < 0.5) { logT("🔄 宏观微调：0.4s 位移仅 " + dist4.toFixed(2) + " 格，后撤侧滑脉冲"); bot.pathfinder.setGoal(null); bot.setControlState('back', true); bot.setControlState(Math.random() > 0.5 ? 'left' : 'right', true); escapeCooldown = 3; }
      } else if (posHistory.length === 8) {
        const dist8 = posHistory[0].distanceTo(currentPos);
        if (dist8 < 1.0) {
          logT("🚨 宏观死锁：0.8s 位移仅 " + dist8.toFixed(2) + " 格，暴力后撤跳！");
          const yaw = bot.entity.yaw; const frontX = Math.floor(currentPos.x - Math.sin(yaw)); const frontZ = Math.floor(currentPos.z + Math.cos(yaw));
          badBlocks.add(frontX + "," + frontZ); bot.pathfinder.setGoal(null); bot.clearControlStates();
          bot.setControlState('back', true); bot.setControlState('jump', true); bot.setControlState(Math.random() > 0.5 ? 'left' : 'right', true);
          escapeCooldown = 6; posHistory.length = 0; 
        }
      }
    } else if (escapeCooldown === 0) { posHistory.length = 0; }
    lastMode = mode; loopCount++; await wait(100); 
  }
  isRunning = false;
}

bot.once("spawn", () => {
  logT("[网络层] 机器人 [" + bot.username + "] 成功空降！");
  const command = "match team:" + TEAM_NUM + " enemy:" + AGAINST_TEAM + " players:" + PER_TEAM_PLAYER + " map:" + MAP_MODE;
  bot.chat(command);
  if (botId === 0) logT("[大厅] 队长发起 3v3 匹配: " + command); else logT("[大厅] 队员申请加入队伍: " + command);
  logT("🕒 等待区块加载中...");
  setTimeout(async () => { if (["Anchor", "Defender", "Supporter"].includes(role)) { await scanSurroundings(); } }, 3000);
});

bot.on("messagestr", (message) => {
  if (message.includes("Are you ready?")) { bot.chat("I'm ready!"); logT("[大厅] 协议确认：Ready!"); }
  else if (message.startsWith("Game start: ")) {
    try {
      const teamData = JSON.parse(message.slice("Game start: ".length));
      if (teamData.left && teamData.left.includes(bot.username)) { myTeam = "L"; homeBanner = "red_banner"; enemyBanner = "blue_banner"; }
      else if (teamData.right && teamData.right.includes(bot.username)) { myTeam = "R"; homeBanner = "blue_banner"; enemyBanner = "red_banner"; }
      if (myTeam) { gameStart = true; gameStartTime = Date.now(); isMapReady = false; gameLoop(); }
    } catch (err) { logT("[异常] 解析游戏开局数据包失败！"); }
  }
  else if (message.includes("Game over!")) {
    gameStart = false; logT("--- 最终战果已锁定 ---");
    logT("\n==============================================");
    logT("[系统] 比赛已结束！正在结算战场数据...");
    logT("==============================================\n");
    try { bot.pathfinder.stop(); bot.clearControlStates(); } catch (e) { }
    logT("[主进程] 机器人已安全离线。"); bot.quit();
  }
});

bot.on("error", (err) => { logT("[Error] 核心异常: " + err.message); });

bot.on("kicked", (reason) => {
  const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
  logT("[Kicked] 遭踢出: " + reasonStr);
  gameStart = false;
  try { bot.pathfinder.stop(); bot.clearControlStates(); } catch (e) { }
  logT('[主进程] 检测到被踢，gameLoop 已终止');
});

bot.on("end", (reason) => { logT("[End] 连接断开: " + reason); gameStart = false; });

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const HOST = process.env.CTF_HOST || '127.0.0.1';
const PORT = Number(process.env.CTF_PORT || 25565);
const VERSION = process.env.CTF_VERSION || '1.21.8';
const USERNAME = process.env.CTF_MOVER_NAME || 'ViewerMover';
const TEAM = process.env.CTF_MOVER_TEAM || 'left';
const MOVE_MS = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: 'offline',
  version: VERSION
});

let stopping = false;
let started = false;

function log(message) {
  console.log(`[free-mover:${USERNAME}] ${message}`);
}

function stop() {
  if (stopping) return;
  stopping = true;
  bot.clearControlStates();
  try { bot.quit('free mover finished'); } catch (_) {}
}

function messageText(message) {
  return typeof message === 'string' ? message : String(message || '');
}

async function moveTo(x, z, timeoutMs = 30000) {
  const target = new Vec3(x, 64, z);
  const startedAt = Date.now();
  let lastLog = 0;
  while (!stopping && Date.now() - startedAt < timeoutMs) {
    if (!bot.entity) { await sleep(MOVE_MS); continue; }
    const position = bot.entity.position;
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.65) {
      bot.clearControlStates();
      return true;
    }
    await bot.lookAt(new Vec3(target.x, position.y + 1.62, target.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    const ahead = bot.blockAt(position.offset(dx / Math.max(distance, 0.01) * 0.8, 0.1, dz / Math.max(distance, 0.01) * 0.8));
    bot.setControlState('jump', !!ahead && ahead.boundingBox === 'block');
    if (Date.now() - lastLog > 3000) {
      lastLog = Date.now();
      log(`line ${position.x.toFixed(1)},${position.z.toFixed(1)} -> ${x.toFixed(1)},${z.toFixed(1)}`);
    }
    await sleep(MOVE_MS);
  }
  bot.clearControlStates();
  return false;
}

async function runTrack() {
  if (started) return;
  started = true;
  await sleep(1500);

  // Straight line across the center, then a return line.
  await moveTo(-12, 0);
  await moveTo(12, 0);
  await moveTo(-12, 0);

  // Smooth circular motion around the center. The bot follows short arc segments,
  // so viewer interpolation shows a continuous curved path.
  const centerX = 0;
  const centerZ = 0;
  const radius = 8;
  const points = 48;
  for (let lap = 0; lap < 2 && !stopping; lap++) {
    for (let i = 0; i <= points && !stopping; i++) {
      const angle = (Math.PI * 2 * i) / points;
      await moveTo(centerX + Math.cos(angle) * radius, centerZ + Math.sin(angle) * radius, 5000);
    }
  }

  // A shorter arc in the left half to exercise a different curvature.
  for (let i = 0; i <= 24 && !stopping; i++) {
    const angle = Math.PI * (i / 24);
    await moveTo(-8 + Math.cos(angle) * 5, 10 + Math.sin(angle) * 5, 5000);
  }

  log('track complete');
  stop();
}

bot.once('spawn', async () => {
  log(`connected to ${HOST}:${PORT}`);
  if (process.env.CTF_MOVER_SETUP === '1') bot.chat('/ctf setup');
  await sleep(process.env.CTF_MOVER_SETUP === '1' ? 700 : 250);
  bot.chat(`match team:viewer-mover enemy:none players:1 map:fixed`);
});

bot.on('messagestr', message => {
  const text = messageText(message);
  if (text.includes('Are you ready?')) bot.chat("I'm ready!");
  if (text.startsWith('Game start: ')) {
    log(`match started for ${TEAM}`);
    runTrack().catch(error => { log(error.stack || error.message); stop(); });
  }
  if (text.includes('Game over!')) stop();
});

bot.on('error', error => log(`error: ${error.message}`));
bot.on('kicked', reason => log(`kicked: ${JSON.stringify(reason)}`));
bot.on('end', reason => {
  stopping = true;
  log(`disconnected: ${reason || 'unknown'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);

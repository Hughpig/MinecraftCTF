const { Vec3 } = require('vec3');
const { performance } = require('node:perf_hooks');

let compared = false;

module.exports = function findArenaFlags(bot, blockId) {
  const start = performance.now();
  const positions = [];
  const point = new Vec3(0, 64, 0);
  // Fixed-map banners, including dropped flags, are always at y=64 within
  // the arena walls. Avoid a synchronous 96-block search through world height.
  const minX = bot.ctf.team === 'left' ? 2 : -23;
  const maxX = bot.ctf.team === 'left' ? 23 : -2;
  for (point.x = minX; point.x <= maxX; point.x++) {
    for (point.z = -35; point.z <= 35; point.z++) {
      if (bot.world.getBlockType(point) === blockId) positions.push(point.clone());
    }
  }
  const boundedMs = performance.now() - start;
  if (process.env.CTF_COMPARE_FLAG_SEARCH === '1' && !compared) {
    compared = true;
    const originalStart = performance.now();
    const original = bot.findBlocks({ matching: blockId, maxDistance: 96, count: 32 })
      .filter(position => bot.ctf.team === 'left' ? position.x > 1 : position.x < -1);
    const originalMs = performance.now() - originalStart;
    const keys = rows => rows.map(p => `${p.x},${p.y},${p.z}`).sort().join('|');
    console.error(`[${new Date().toISOString()}] [flag-search] original=${originalMs.toFixed(1)}ms bounded=${boundedMs.toFixed(1)}ms positionsMatch=${keys(original) === keys(positions)} count=${positions.length}`);
  } else if (process.env.CTF_DEBUG_LOOP === '1' && boundedMs > 15) {
    console.error(`[${new Date().toISOString()}] [flag-search] bounded=${boundedMs.toFixed(1)}ms count=${positions.length}`);
  }
  return positions;
};

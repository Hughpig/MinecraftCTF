const { Vec3 } = require('vec3');

// Unlocked home goals: gold blocks at y=63 in the bot's own half with air
// above. A locked goal carries the lime banner marker at y=64 and is skipped,
// so carriers head for a target that can actually accept a flag. Random stand
// layouts put goals anywhere in the home half, so hardcoding the legacy rows
// makes carriers circle around empty coordinates.
module.exports = function findArenaGoals(bot) {
  const gold = bot.registry && bot.registry.blocksByName.gold_block;
  if (!gold || !bot.entity || !bot.ctf || !bot.ctf.team) return [];
  const sign = bot.ctf.team === 'left' ? -1 : 1;
  const positions = [];
  const point = new Vec3(0, 63, 0);
  for (let dx = 2; dx <= 10; dx++) {
    point.x = sign * dx;
    for (point.z = -35; point.z <= 35; point.z++) {
      if (bot.world.getBlockType(point) !== gold.id) continue;
      if (bot.world.getBlockType(new Vec3(point.x, 64, point.z)) !== 0) continue;
      positions.push(point.clone());
    }
  }
  return positions;
};

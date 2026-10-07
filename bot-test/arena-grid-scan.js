const { Vec3 } = require('vec3');

// One-shot arena occupancy scan for the A* pathfinder: '#' where the feet
// block (y=64) is solid, '.' where clear. The arena is flat, so one level
// decides walkability. The arena walls at x=±24 serve callers as the
// loaded-chunks canary before they trust a scan.
module.exports = function scanArenaGrid(bot) {
  const rows = [];
  const point = new Vec3(0, 64, 0);
  for (point.z = -35; point.z <= 35; point.z++) {
    let row = '';
    for (point.x = -23; point.x <= 23; point.x++) {
      row += bot.world.getBlockType(point) !== 0 ? '#' : '.';
    }
    rows.push(row);
  }
  return { x0: -23, z0: -35, rows };
};

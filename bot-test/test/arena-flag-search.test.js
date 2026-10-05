const assert = require('node:assert/strict');
const { test } = require('node:test');
const findArenaFlags = require('../arena-flag-search');

test('finds live and dropped enemy banners throughout the fixed arena', () => {
  for (const team of ['left', 'right']) {
    const sign = team === 'left' ? 1 : -1;
    const banners = new Set([`${sign * 18},64,-30`, `${sign * 3},64,35`]);
    const positions = findArenaFlags({
      ctf: { team },
      world: { getBlockType(p) { return banners.has(`${p.x},${p.y},${p.z}`) ? 123 : 0; } }
    }, 123);
    assert.deepEqual(positions.map(p => p.toArray().join(',')).sort(), [...banners].sort());
  }
});

test('searches only flag height in the enemy half and stays bounded when no flag exists', () => {
  let reads = 0;
  const positions = findArenaFlags({
    ctf: { team: 'left' },
    world: { getBlockType(p) {
      assert.equal(p.y, 64);
      assert.ok(p.x >= 2 && p.x <= 23 && p.z >= -35 && p.z <= 35);
      reads++;
      return 0;
    } }
  }, 123);
  assert.deepEqual(positions, []);
  assert.equal(reads, 1562);
});

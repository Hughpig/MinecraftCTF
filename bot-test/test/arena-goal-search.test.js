const assert = require('node:assert/strict');
const { test } = require('node:test');
const findArenaGoals = require('../arena-goal-search');

const GOLD = 41, LIME = 99;
const goldAt = new Set(['-4,7', '-7,-6', '5,7']);
const bannerAbove = new Set(['-7,63,-6']);

test('finds unlocked own-half gold goals and skips locked and enemy-half ones', () => {
  const goals = findArenaGoals({
    ctf: { team: 'left' },
    entity: { position: { x: 0, z: 0 } },
    registry: { blocksByName: { gold_block: { id: GOLD } } },
    world: { getBlockType(p) {
      if (p.y === 63) return goldAt.has(`${p.x},${p.z}`) ? GOLD : 0;
      if (p.y === 64) return bannerAbove.has(`${p.x},63,${p.z}`) ? LIME : 0;
      return 0;
    } }
  });
  assert.deepEqual(goals.map(p => `${p.x},${p.y},${p.z}`), ['-4,63,7']);
});

test('scans the right half for the blue team', () => {
  const reads = [];
  findArenaGoals({
    ctf: { team: 'right' },
    entity: { position: { x: 0, z: 0 } },
    registry: { blocksByName: { gold_block: { id: GOLD } } },
    world: { getBlockType(p) { reads.push(`${p.x},${p.y},${p.z}`); return 0; } }
  });
  assert.ok(reads.every(key => Number(key.split(',')[0]) >= 2));
  assert.ok(reads.includes('10,63,0') && reads.includes('2,63,35'));
});

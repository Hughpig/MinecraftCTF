const assert = require('node:assert/strict');
const { test } = require('node:test');
const { takeNearest } = require('../flag-state');

test('pops the cell nearest to the picker position', () => {
  const cells = new Map([['4,10', { x: 4, z: 10 }], ['20,-30', { x: 20, z: -30 }]]);
  assert.deepEqual(takeNearest(cells, 5, 9), { x: 4, z: 10 });
  assert.equal(cells.size, 1);
  assert.deepEqual(takeNearest(cells, 20, -30), { x: 20, z: -30 });
  assert.equal(cells.size, 0);
  assert.equal(takeNearest(cells, 0, 0), null);
});

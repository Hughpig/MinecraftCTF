const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findPath, passable } = require('../ctf-path');

// 9x9 grid, origin (0,0): a wall column at x=4 with a single gap at z=6.
const WALL_ROWS = [
  '....#....',
  '....#....',
  '....#....',
  '....#....',
  '....#....',
  '....#....',
  '.........',
  '....#....',
  '....#....'
];
const ORIGIN = [0, 0];

test('returns the goal cell centre when the line is clear', () => {
  const open = ['.........', '.........'];
  assert.deepEqual(findPath(open, [0, 0], [1, 0], [8, 1]), [[8.5, 1.5]]);
});

test('detours around a wall through the gap and never crosses it', () => {
  const path = findPath(WALL_ROWS, ORIGIN, [1, 1], [7, 1]);
  assert.ok(path, 'path exists');
  assert.deepEqual(path[path.length - 1], [7.5, 1.5]);
  for (const [x, z] of path) {
    const cx = Math.floor(x), cz = Math.floor(z);
    assert.ok(passable(WALL_ROWS, ORIGIN, cx, cz), `waypoint ${x},${z} in a walkable cell`);
  }
  // The route crosses the wall column only around the gap row.
  for (const [x, z] of path) {
    const cx = Math.floor(x);
    if (cx === 4 || cx === 5) assert.ok(Math.floor(z) >= 5 && Math.floor(z) <= 7, `crossing near gap at ${x},${z}`);
  }
});

test('returns null for enclosed goals and blocked starts', () => {
  const boxed = [
    '.........',
    '.#######.',
    '.#.....#.',
    '.#.....#.',
    '.#.....#.',
    '.#######.',
    '.........'
  ];
  assert.equal(findPath(boxed, [0, 0], [1, 1], [4, 3]), null);
  assert.equal(findPath(WALL_ROWS, ORIGIN, [4, 0], [7, 1]), null); // start inside the wall
  assert.equal(findPath(WALL_ROWS, ORIGIN, [1, 1], [4, 4]), null); // goal inside the wall
});

test('smoothing collapses a long detour into few waypoints', () => {
  const path = findPath(WALL_ROWS, ORIGIN, [1, 1], [7, 1]);
  assert.ok(path.length <= 4, `few waypoints, got ${path.length}`);
});

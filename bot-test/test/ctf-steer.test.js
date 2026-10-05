const assert = require('node:assert/strict');
const { test } = require('node:test');
const { firstBlockedCell, planSteer, strafeSideForAway } = require('../ctf-steer');

function probeFor(solid) {
  return (x, z, level) => solid.has(`${x},${z}`);
}

function treeAt(cx, cz, target = new Set()) {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) target.add(`${cx + dx},${cz + dz}`);
  return target;
}

test('clear line steers straight to the target', () => {
  const r = planSteer({ position: { x: 0, z: 0 }, target: { x: 10, z: 0 }, detour: null, probe: probeFor(new Set()) });
  assert.deepEqual(r, { steerPoint: { x: 10, z: 0 }, detour: null });
});

test('firstBlockedCell only reports two-high walls', () => {
  const solid = treeAt(5, 0);
  const probe = probeFor(solid);
  assert.deepEqual(firstBlockedCell(probe, { x: 2.5, z: 0.5 }, { x: 10, z: 0.5 }), { x: 4, z: 0 });
  const singleHigh = (x, z, level) => level === 0 && solid.has(`${x},${z}`);
  assert.equal(firstBlockedCell(singleHigh, { x: 2.5, z: 0.5 }, { x: 10, z: 0.5 }), null);
});

test('3x3 tree ahead creates a detour on the free side', () => {
  const r = planSteer({ position: { x: 2.5, z: 0.5 }, target: { x: 10, z: 0.5 }, detour: null, probe: probeFor(treeAt(5, 0)) });
  assert.equal(r.detour.key, '4,0');
  assert.equal(r.detour.side, 1);
  assert.ok(Math.abs(r.steerPoint.x - 5.7) < 1e-9);
  assert.ok(Math.abs(r.steerPoint.z - 3.7) < 1e-9);
});

test('detour holds beside the obstacle and resumes once cleared', () => {
  const probe = probeFor(treeAt(5, 0));
  const detour = { key: '4,0', blocked: { x: 4, z: 0 }, side: 1, waypoint: { x: 5.7, z: 3.1 } };
  const holding = planSteer({ position: { x: 4, z: 3 }, target: { x: 10, z: 0.5 }, detour, probe });
  assert.equal(holding.detour.key, '4,0');
  const resumed = planSteer({ position: { x: 8, z: 3 }, target: { x: 10, z: 0.5 }, detour, probe });
  assert.equal(resumed.detour, null);
  assert.deepEqual(resumed.steerPoint, { x: 10, z: 0.5 });
});

test('detour clears immediately when the obstacle disappears', () => {
  const probe = probeFor(new Set());
  const detour = { key: '4,0', blocked: { x: 4, z: 0 }, side: 1, waypoint: { x: 5.7, z: 3.1 } };
  const r = planSteer({ position: { x: 4, z: 3 }, target: { x: 10, z: 0.5 }, detour, probe });
  assert.equal(r.detour, null);
});

test('blocked on both sides falls back to direct steering', () => {
  const solid = new Set();
  for (let x = 4; x <= 6; x++) for (let z = -3; z <= 3; z++) solid.add(`${x},${z}`);
  const r = planSteer({ position: { x: 2.5, z: 0.5 }, target: { x: 10, z: 0.5 }, detour: null, probe: probeFor(solid) });
  assert.equal(r.detour, null);
  assert.deepEqual(r.steerPoint, { x: 10, z: 0.5 });
});

test('detour re-plans when another obstacle blocks the waypoint path', () => {
  const solid = treeAt(5, 0);
  treeAt(6, 2, solid);
  const probe = probeFor(solid);
  const detour = { key: '4,0', blocked: { x: 4, z: 0 }, side: 1, waypoint: { x: 5.7, z: 3.1 } };
  const r = planSteer({ position: { x: 4.5, z: 2.5 }, target: { x: 10, z: 0.5 }, detour, probe });
  assert.equal(r.detour.key, '5,2');
  assert.notEqual(r.steerPoint.x, detour.waypoint.x);
});

test('strafe side moves away from the opponent', () => {
  const facing = { x: 0, z: -1 }; // north
  assert.equal(strafeSideForAway(facing, { x: -1, z: 0 }), 'left');
  assert.equal(strafeSideForAway(facing, { x: 1, z: 0 }), 'right');
  assert.equal(strafeSideForAway(facing, { x: 0, z: -1 }), null);
});

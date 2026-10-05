// Obstacle-aware steering decisions shared by the local CTF bots. The logic is
// pure apart from an injectable block probe, so tests drive it on synthetic
// grids and a future pathfinder can replace the internals without touching the
// callers. Coordinates are arena cells: probe(x, z, level) reports whether the
// cell is solid for movement, level 0 = feet, level 1 = head.

const { Vec3 } = require('vec3');

const DOORS = new Set(['iron_door', 'oak_door', 'spruce_door', 'birch_door', 'dark_oak_door']);

// Builds the movement probe from a bot. Open doors report a 'block' bounding
// box even though they do not collide, so they must be treated as passable —
// otherwise bots detour around their own open prison door.
function makeBlockProbe(bot) {
  return (x, z, level) => {
    const block = bot.blockAt(new Vec3(x, 64 + level, z));
    if (!block || block.boundingBox !== 'block') return false;
    if (DOORS.has(block.name)) {
      const open = block.properties ? block.properties.open : undefined;
      if (open === true || open === 'true') return false;
    }
    return true;
  };
}

const DETOUR_CLEAR_DISTANCE = 3.5;
const DETOUR_LATERAL = 3.2;
const DETOUR_FORWARD = 1.2;

function normalize(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, len: Math.hypot(dx, dz) };
}

function isTwoHighWall(probe, x, z) {
  return probe(x, z, 0) && probe(x, z, 1);
}

// Nearest free cell to a hardcoded waypoint: spiral search so patrol targets
// that ended up inside a tree can still be reached.
function nearestFreeCell(probe, x, z, maxRadius = 3) {
  if (!isTwoHighWall(probe, x, z)) return { x, z };
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      if (!isTwoHighWall(probe, x + dx, z + dz)) return { x: x + dx, z: z + dz };
    }
  }
  return { x, z };
}

// First cell along the straight line whose feet AND head block are solid —
// a two-block wall the bot cannot jump over. Single-block obstacles stay the
// caller's jump concern.
function firstBlockedCell(probe, from, target, maxLook = 3) {
  const { x: ux, z: uz, len } = normalize(from, target);
  if (len < 0.01) return null;
  const limit = Math.min(len - 0.4, maxLook);
  for (let d = 0.6; d <= limit; d += 0.5) {
    const x = Math.floor(from.x + ux * d);
    const z = Math.floor(from.z + uz * d);
    if (isTwoHighWall(probe, x, z)) return { x, z };
  }
  return null;
}

// Side (+1/-1) whose escape point beside the obstacle is clear; 0 when both
// sides are blocked and the caller's stall nudge has to take over.
function pickSide(probe, from, target, blocked) {
  const { x: ux, z: uz } = normalize(from, target);
  for (const side of [1, -1]) {
    const x = Math.floor(blocked.x + 0.5 - uz * side * DETOUR_LATERAL);
    const z = Math.floor(blocked.z + 0.5 + ux * side * DETOUR_LATERAL);
    if (!probe(x, z, 0) && !probe(x, z, 1)) return side;
  }
  return 0;
}

function detourWaypoint(from, target, blocked, side) {
  const { x: ux, z: uz } = normalize(from, target);
  return {
    x: blocked.x + 0.5 - uz * side * DETOUR_LATERAL + ux * DETOUR_FORWARD,
    z: blocked.z + 0.5 + ux * side * DETOUR_LATERAL + uz * DETOUR_FORWARD
  };
}

// Decide where to steer this step. detour carries the obstacle being rounded
// (key, blocked cell, side, waypoint); it clears once the straight line to the
// real target is open again and the obstacle is behind or far enough away.
function planSteer({ position, target, detour, probe }) {
  if (detour) {
    const awayFromBlocked = Math.hypot(position.x - (detour.blocked.x + 0.5), position.z - (detour.blocked.z + 0.5));
    const obstacleGone = !probe(detour.blocked.x, detour.blocked.z, 0);
    if ((!firstBlockedCell(probe, position, target) && awayFromBlocked >= DETOUR_CLEAR_DISTANCE) || obstacleGone) {
      return { steerPoint: target, detour: null };
    }
    const nextBlocked = firstBlockedCell(probe, position, detour.waypoint, 2);
    if (nextBlocked && `${nextBlocked.x},${nextBlocked.z}` !== detour.key) {
      const side = pickSide(probe, position, detour.waypoint, nextBlocked);
      if (side !== 0) {
        return {
          steerPoint: detourWaypoint(position, detour.waypoint, nextBlocked, side),
          detour: { key: `${nextBlocked.x},${nextBlocked.z}`, blocked: nextBlocked, side, waypoint: detourWaypoint(position, detour.waypoint, nextBlocked, side) }
        };
      }
    }
    return { steerPoint: detour.waypoint, detour };
  }
  const blocked = firstBlockedCell(probe, position, target);
  if (!blocked) return { steerPoint: target, detour: null };
  const side = pickSide(probe, position, target, blocked);
  if (side === 0) return { steerPoint: target, detour: null };
  const waypoint = detourWaypoint(position, target, blocked, side);
  return { steerPoint: waypoint, detour: { key: `${blocked.x},${blocked.z}`, blocked, side, waypoint } };
}

// Which strafe key moves the bot AWAY from the opponent while it faces the
// target. facing/away are unit vectors in arena space; returns 'left', 'right'
// or null when the away direction has no lateral component (fallback random).
function strafeSideForAway(facing, away) {
  const leftX = facing.z, leftZ = -facing.x;
  const dot = away.x * leftX + away.z * leftZ;
  if (Math.abs(dot) < 0.1) return null;
  return dot > 0 ? 'left' : 'right';
}

module.exports = { firstBlockedCell, planSteer, pickSide, strafeSideForAway, isTwoHighWall, makeBlockProbe, nearestFreeCell };

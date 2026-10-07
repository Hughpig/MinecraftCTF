// Grid A* for the arena occupancy map. The grid is row strings from one
// Node-side scan ('#' = feet block solid, '.' = clear), with origin (x0, z0)
// at rows[0][0]. Pure and mirrored by bot-test/python/ctf_path.py — same
// algorithm, same tests. The arena is flat, so walkability is decided at feet
// level alone; the local steering still owns avoidance, the path only
// supplies the global route.

const BOT_HALF_WIDTH = 0.35;

const STEPS = [
  [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
  [1, 1, 1.42], [1, -1, 1.42], [-1, 1, 1.42], [-1, -1, 1.42]
];

function passable(rows, origin, x, z) {
  const i = z - origin[1];
  const j = x - origin[0];
  if (i < 0 || i >= rows.length) return false;
  const row = rows[i];
  if (j < 0 || j >= row.length) return false;
  return row[j] === '.';
}

function lineClear(rows, origin, a, b) {
  // Samples outside the grid are skipped: the grid stops one cell short of
  // the arena walls, and A* nodes never leave it anyway.
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 4 + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    for (const cx of [Math.floor(x - BOT_HALF_WIDTH), Math.floor(x + BOT_HALF_WIDTH)]) {
      for (const cz of [Math.floor(z - BOT_HALF_WIDTH), Math.floor(z + BOT_HALF_WIDTH)]) {
        const row = cz - origin[1];
        const col = cx - origin[0];
        if (row < 0 || row >= rows.length || col < 0 || col >= rows[0].length) continue;
        if (rows[row][col] !== '.') return false;
      }
    }
  }
  return true;
}

const center = cell => [cell[0] + 0.5, cell[1] + 0.5];

// Greedy string-pull over cell centres: keep only waypoints the direct
// segment can reach. Returns centre coordinates the bot actually steers to.
function smoothPath(rows, origin, path) {
  if (path.length <= 1) return path.map(center);
  const result = [];
  let current = center(path[0]);
  let i = 1;
  while (i < path.length) {
    let j = path.length - 1;
    while (j > i && !lineClear(rows, origin, current, center(path[j]))) j--;
    current = center(path[j]);
    result.push(current);
    i = j + 1;
  }
  return result;
}

// Minimal binary min-heap over [priority, value] pairs.
function makeHeap() {
  return {
    items: [],
    push(item) {
      const items = this.items;
      items.push(item);
      let i = items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (items[parent][0] <= items[i][0]) break;
        [items[parent], items[i]] = [items[i], items[parent]];
        i = parent;
      }
    },
    pop() {
      const items = this.items;
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          const right = left + 1;
          let smallest = i;
          if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
          if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
          if (smallest === i) break;
          [items[smallest], items[i]] = [items[i], items[smallest]];
          i = smallest;
        }
      }
      return top;
    },
    get length() { return this.items.length; }
  };
}

// Waypoint cells (world ints, start excluded) from start to goal, or null
// when either end is blocked or no route exists. Diagonals never cut corners:
// both orthogonal cells must be clear.
function findPath(rows, origin, start, goal) {
  const [sx, sz] = start;
  const [tx, tz] = goal;
  if (!passable(rows, origin, sx, sz) || !passable(rows, origin, tx, tz)) return null;
  if (sx === tx && sz === tz) return [];

  const heuristic = (x, z) => {
    const dx = Math.abs(x - tx);
    const dz = Math.abs(z - tz);
    return Math.max(dx, dz) + 0.42 * Math.min(dx, dz);
  };

  const openHeap = makeHeap();
  openHeap.push([0.0, start]);
  const came = new Map([[start.join(','), null]]);
  const costs = new Map([[start.join(','), 0.0]]);
  while (openHeap.length > 0) {
    const [, current] = openHeap.pop();
    const currentKey = current.join(',');
    if (current[0] === tx && current[1] === tz) {
      const path = [];
      let node = current;
      while (node && !(node[0] === sx && node[1] === sz)) {
        path.push(node);
        node = came.get(node.join(','));
      }
      path.reverse();
      return smoothPath(rows, origin, path);
    }
    const [cx, cz] = current;
    const currentCost = costs.get(currentKey);
    for (const [dx, dz, cost] of STEPS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!passable(rows, origin, nx, nz)) continue;
      if (dx !== 0 && dz !== 0
          && !(passable(rows, origin, cx + dx, cz) && passable(rows, origin, cx, cz + dz))) {
        continue; // no corner cutting through wall tips
      }
      const nextCost = currentCost + cost;
      const nextKey = `${nx},${nz}`;
      if (!costs.has(nextKey) || nextCost < costs.get(nextKey)) {
        costs.set(nextKey, nextCost);
        came.set(nextKey, current);
        openHeap.push([nextCost + heuristic(nx, nz), [nx, nz]]);
      }
    }
  }
  return null;
}

module.exports = { findPath, smoothPath, passable, lineClear };

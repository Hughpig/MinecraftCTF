// Event-maintained flag/goal state helpers for the jump-smart bots. The
// server broadcasts every state change the route code cares about — pickups
// ("[CTF] NAME 夺取了 X 队的一面旗。"), deposits ("X 队已插旗 N/8。"), captures
// (the jail broadcast implies a carrier's flag re-plants at an unannounced
// spot) — so bots keep a live banner/goal table from chat instead of
// re-reading the world every few hundred milliseconds. Pure helpers live
// here; the bots own the caches and the scan-based reconciliation.

// Pop and return the cell nearest to (x, z) from a Map of key -> {x, z}.
function takeNearest(cells, x, z) {
  let bestKey = null;
  let bestDistance = Infinity;
  for (const [key, cell] of cells) {
    const distance = (cell.x - x) ** 2 + (cell.z - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKey = key;
    }
  }
  if (bestKey === null) return null;
  const cell = cells.get(bestKey);
  cells.delete(bestKey);
  return cell;
}

module.exports = { takeNearest };

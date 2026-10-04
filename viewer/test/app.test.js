const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function createViewer(sourcePath = path.join(__dirname, '../public/app.js')) {
  let now = 10000;
  const metrics = { textWrites: 0, fillText: 0, fillRect: 0, canvasResizes: 0 };
  const elements = new Map();
  function element() {
    let content = '';
    return {
      dataset: {}, children: [], checked: true,
      classList: { toggle() {} },
      setAttribute() {}, addEventListener() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      get textContent() { return content; },
      set textContent(value) { metrics.textWrites++; content = String(value); },
      set width(value) { metrics.canvasResizes++; this.canvasWidth = value; },
      get width() { return this.canvasWidth; },
      set height(value) { metrics.canvasResizes++; this.canvasHeight = value; },
      get height() { return this.canvasHeight; },
      getBoundingClientRect() { return { width: 770, height: 530 }; },
      getContext() {
        return new Proxy({}, {
          get(target, property) {
            if (property === 'measureText') return text => ({ width: text.length * 7 });
            if (property === 'fillText' || property === 'fillRect') return () => { metrics[property]++; };
            return () => {};
          }
        });
      }
    };
  }
  const sandbox = vm.createContext({
    console, Date: class extends Date { static now() { return now; } },
    document: {
      createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      }
    },
    window: { devicePixelRatio: 2 },
    EventSource: class {}, ResizeObserver: class { observe() {} },
    requestAnimationFrame() {}, setInterval() {}, setTimeout(callback) { callback(); return 0; }
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), sandbox);
  vm.runInContext('gatewayConnected = true', sandbox);
  return {
    metrics, elements,
    run: code => vm.runInContext(code, sandbox),
    receive(snapshot, receivedAt = snapshot?.updatedAt || now) {
      now = receivedAt;
      sandbox.incoming = { connected: !!snapshot, snapshot, demo: { status: 'idle' } };
      vm.runInContext('receive(incoming)', sandbox);
    },
    setTime(value) { now = value; }
  };
}

function snapshot(updatedAt = 10000, playerCount = 6) {
  return {
    updatedAt, online: true, mapBuilt: true, phase: 'running',
    bounds: { minX: -24, maxX: 24, minZ: -36, maxZ: 36 },
    scores: { left: 0, right: 0 }, remainingSeconds: 180,
    blocks: [], prisons: [], events: [],
    flags: [{ id: 'left-0', team: 'left', x: -20, z: 0, status: 'available' }],
    targets: [{ id: 'right-0', team: 'right', x: 20, z: 0, locked: false }],
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: String(index), name: `Player_${index}`, team: index % 2 ? 'right' : 'left',
      x: index, z: 0, carrying: '', jailedSeconds: 0, ready: true
    }))
  };
}

test('1v1 and 3v3 reuse labels and objectives across animation frames', () => {
  for (const playerCount of [2, 6]) {
    const viewer = createViewer();
    viewer.receive(snapshot(10000, playerCount));
    viewer.run('draw()');
    const before = { ...viewer.metrics };
    for (let frame = 0; frame < 60; frame++) viewer.run('draw()');
    assert.equal(viewer.metrics.fillText, before.fillText);
    assert.equal(viewer.metrics.fillRect, before.fillRect);
    assert.equal(viewer.metrics.canvasResizes, before.canvasResizes);
  }
});

test('position-only snapshots do not rewrite HUD text or rebuild static content', () => {
  const viewer = createViewer();
  viewer.receive(snapshot());
  viewer.run('draw()');
  const before = { ...viewer.metrics };
  for (let frame = 1; frame <= 10; frame++) {
    const state = snapshot(10000 + frame * 100);
    state.players.forEach(player => { player.x += frame / 10; });
    viewer.receive(state);
    viewer.run('draw()');
  }
  assert.equal(viewer.metrics.textWrites, before.textWrites);
  assert.equal(viewer.metrics.fillText, before.fillText);
  assert.equal(viewer.metrics.fillRect, before.fillRect);
});

test('flag, target, name and perspective changes invalidate their cached content', () => {
  const viewer = createViewer();
  viewer.receive(snapshot());
  viewer.run('draw()');
  const before = viewer.metrics.fillRect;
  const changed = snapshot(10100);
  changed.flags[0].status = 'carried';
  changed.targets[0].locked = true;
  changed.targets[0].flagTeam = 'left';
  changed.prisons = [{ team: 'left', x: -15.5, z: 28.5, doorX: -15.5, doorZ: 26.5, plateX: -15.5, plateZ: 24.5, open: false }];
  viewer.receive(changed);
  viewer.run('draw()');
  assert.ok(viewer.metrics.fillRect > before);
  viewer.run("setPerspective('right')");
  assert.equal(viewer.run('staticLayerDirty'), true);
  assert.equal(viewer.run('objectiveLayerDirty'), true);
  viewer.run('draw()');
  const changedAgain = snapshot(10200);
  changedAgain.flags[0].status = 'carried';
  changedAgain.targets[0].locked = true;
  changedAgain.targets[0].flagTeam = 'left';
  changedAgain.players[0].name = 'Renamed';
  changedAgain.prisons = [{ team: 'left', x: -15.5, z: 28.5, doorX: -15.5, doorZ: 26.5, plateX: -15.5, plateZ: 24.5, open: true }];
  viewer.receive(changedAgain);
  assert.equal(viewer.run('staticLayerDirty'), false);
  assert.equal(viewer.run('objectiveLayerDirty'), true);
  viewer.run('draw()');
  assert.ok(viewer.run("[...labelCache.keys()].some(key => key.includes('Renamed'))"));
});

test('repeated resize notifications preserve the canvas buffers', () => {
  const viewer = createViewer();
  const before = viewer.metrics.canvasResizes;
  viewer.run('resize(); resize()');
  assert.equal(viewer.metrics.canvasResizes, before);
});

test('interpolation uses snapshot time and steps across teleports without reversing', () => {
  const viewer = createViewer();
  viewer.receive(snapshot());
  const moved = snapshot(10200);
  moved.players[0].x = 1;
  viewer.receive(moved);
  viewer.setTime(10400);
  assert.ok(Math.abs(viewer.run('interpolatedPosition(envelope.snapshot.players[0], interpolationFrames()).x') - 0.95) < 1e-9);
  const teleported = snapshot(10400);
  teleported.players[0].x = 20;
  viewer.receive(teleported, 10400);
  viewer.setTime(10600);
  assert.equal(viewer.run('interpolatedPosition(envelope.snapshot.players[0], interpolationFrames()).x'), 1);
  const afterTeleport = snapshot(10600);
  afterTeleport.players[0].x = 21;
  viewer.receive(afterTeleport, 10600);
  viewer.setTime(10700);
  assert.equal(viewer.run('interpolatedPosition(envelope.snapshot.players[0], interpolationFrames()).x'), 20);
});

test('startup blending does not fall back to an older frame', () => {
  const viewer = createViewer();
  viewer.receive(snapshot(10000));
  const firstMove = snapshot(10200);
  firstMove.players[0].x = 1;
  viewer.receive(firstMove);
  viewer.setTime(10300);
  const openingPosition = viewer.run('interpolatedPosition(envelope.snapshot.players[0], interpolationFrames()).x');

  const secondMove = snapshot(10400);
  secondMove.players[0].x = 2;
  viewer.receive(secondMove);
  viewer.setTime(10500);
  const blendedPosition = viewer.run('interpolatedPosition(envelope.snapshot.players[0], interpolationFrames()).x');

  assert.ok(openingPosition >= 1);
  assert.ok(blendedPosition > openingPosition);
});

test('missing and restarted snapshots clear old interpolation history', () => {
  const viewer = createViewer();
  viewer.receive(snapshot());
  viewer.receive(null);
  viewer.run('draw()');
  assert.equal(viewer.run('playerFrames.length'), 0);
  viewer.receive(snapshot());
  viewer.receive(snapshot(9000));
  assert.equal(viewer.run('playerFrames.length'), 1);
  assert.equal(viewer.run('playerFrames[0].at'), 9000);
});

test('the roster updates when the match phase changes without player changes', () => {
  const viewer = createViewer();
  viewer.receive(snapshot());
  const roster = viewer.elements.get('player-list');
  const previousRow = roster.children[0];
  const finished = snapshot(10100);
  finished.phase = 'finished';
  viewer.receive(finished);
  assert.notEqual(roster.children[0], previousRow);
});

module.exports = { createViewer, snapshot };

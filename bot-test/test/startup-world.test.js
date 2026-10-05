const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const waitForInitialWorld = require('../startup-world');

function makeBot() {
  const bot = new EventEmitter();
  bot.entity = { position: { x: -0.5, z: 0.5 } };
  bot.world = { getColumn: () => ({}) };
  return bot;
}

test('waits for spawn, all nearby chunks, and quiet after the last chunk', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const bot = makeBot();
  let terrainLoaded = false;
  bot.world.getColumn = (x, z) => {
    assert.ok(x >= -3 && x <= 1 && z >= -2 && z <= 2);
    return terrainLoaded ? {} : null;
  };
  let ready = false;
  const waiting = waitForInitialWorld(bot).then(() => { ready = true; });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(ready, false);
  bot.emit('spawn');
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(ready, false);
  terrainLoaded = true;
  bot.emit('chunkColumnLoad');
  t.mock.timers.tick(700);
  await Promise.resolve();
  assert.equal(ready, false);
  bot.emit('chunkColumnLoad');
  t.mock.timers.tick(700);
  await Promise.resolve();
  assert.equal(ready, false);
  t.mock.timers.tick(100);
  await waiting;
  assert.equal(ready, true);
  assert.equal(bot.eventNames().length, 0);
});

test('disconnect aborts startup and removes listeners', async () => {
  const bot = makeBot();
  const waiting = waitForInitialWorld(bot);
  bot.emit('end', 'connection closed');
  await assert.rejects(waiting, /disconnected during startup/);
  assert.equal(bot.eventNames().length, 0);
});

test('missing terrain times out instead of preventing future bot launches indefinitely', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const bot = makeBot();
  const waiting = waitForInitialWorld(bot);
  t.mock.timers.tick(30000);
  await assert.rejects(waiting, /terrain did not become ready/);
  assert.equal(bot.eventNames().length, 0);
});

test('stopping cancels startup without retaining listeners', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const bot = makeBot();
  const waiting = waitForInitialWorld(bot, { isStopping: () => true });
  t.mock.timers.tick(100);
  await assert.rejects(waiting, /startup cancelled/);
  assert.equal(bot.eventNames().length, 0);
});

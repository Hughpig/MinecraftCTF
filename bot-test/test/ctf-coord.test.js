const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CHAT_PREFIX, parseCoordination, claimKey, claimMessage, unclaimMessage, rescueMessage, freedMessage } = require('../ctf-coord');

const teammates = new Set(['RY_1', 'RY_2']);

test("parses a teammate's claim line", () => {
  assert.deepEqual(
    parseCoordination('<RY_1> [CTFC] c -14,-22', 'RY_2', teammates),
    { sender: 'RY_1', command: 'c', arg: '-14,-22' }
  );
});

test('drops own lines, opponent lines, system broadcasts, and plain chat', () => {
  assert.equal(parseCoordination('<RY_2> [CTFC] c 1,2', 'RY_2', teammates), null);
  assert.equal(parseCoordination('<BJ_1> [CTFC] c 1,2', 'RY_2', teammates), null);
  assert.equal(parseCoordination('[CTF] RY_1 被抓捕并关入 左 队监狱。', 'RY_2', teammates), null);
  assert.equal(parseCoordination('<RY_1> go flag 14.8,2.3 (claimed)', 'RY_2', teammates), null);
});

test('requires a parsed roster: unknown senders and pre-game silence', () => {
  assert.equal(parseCoordination('<RJ_1> [CTFC] r RY_2', 'RY_2', teammates), null);
  assert.equal(parseCoordination('<RY_1> [CTFC] f', 'RY_2', undefined), null);
});

test('claim keys round to shared block coordinates', () => {
  assert.equal(claimKey(14.0, -22.0), '14,-22');
  assert.equal(claimKey(13.999, -21.6), '14,-22');
});

test('message builders match the [CTFC] wire format shared with the py bots', () => {
  assert.equal(CHAT_PREFIX, '[CTFC]');
  assert.equal(claimMessage('14,-22'), 'c 14,-22');
  assert.equal(unclaimMessage('14,-22'), 'u 14,-22');
  assert.equal(rescueMessage('RJ_1'), 'r RJ_1');
  assert.equal(freedMessage(), 'f');
  // The Python module emits the same wire format; parse one of its lines.
  assert.deepEqual(
    parseCoordination('<RY_1> [CTFC] u 14,-22', 'RY_2', teammates),
    { sender: 'RY_1', command: 'u', arg: '14,-22' }
  );
});

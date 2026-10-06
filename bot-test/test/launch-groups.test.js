const assert = require('node:assert/strict');
const { test } = require('node:test');
const { composeGroups, parseTeamSpec, composeMapExtra } = require('../../scripts/launch-groups');

test('mixed team spawns one process per (side, style) with pinned sides', () => {
  const groups = composeGroups({
    mode: 'both',
    red: { smart: 2, simple: 1 },
    blue: { smart: 3, simple: 0 },
    map: { mode: 'random', obstacles: '', stands: '', seed: '42' }
  });
  assert.deepEqual(groups.map(g => `${g.side}:${g.style}:${g.count}`), ['left:smart:2', 'left:simple:1', 'right:smart:3']);
  assert.deepEqual(groups.map(g => g.env.CTF_NAME_PREFIX), ['RS', 'RX', 'BS']);
  assert.ok(groups.every(g => g.env.CTF_SETUP === '0' || g.env.CTF_SETUP === '1'));
  assert.equal(groups.filter(g => g.env.CTF_SETUP === '1').length, 1);
  assert.equal(groups[0].env.CTF_MATCH_EXTRA, 'seed:42');
  assert.ok(groups.every(g => g.env.CTF_ENEMY === 'bot'));
});

test('players per side uses the smaller team so asymmetric line-ups still start', () => {
  const groups = composeGroups({
    mode: 'both',
    red: { smart: 3, simple: 0 },
    blue: { smart: 0, simple: 2 },
    map: { mode: 'fixed' }
  });
  assert.ok(groups.every(g => g.env.CTF_PLAYERS === '2'));
});

test('single-team mode uses enemy:none and only the red side', () => {
  const groups = composeGroups({
    mode: 'red',
    red: { smart: 2, simple: 0 },
    blue: { smart: 0, simple: 0 },
    map: { mode: 'fixed' }
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].side, 'left');
  assert.equal(groups[0].env.CTF_ENEMY, 'none');
});

test('map extras compose overrides and skip defaults', () => {
  assert.equal(composeMapExtra({ mode: 'random', obstacles: '', stands: '', seed: '' }), '');
  assert.equal(composeMapExtra({ mode: 'random', obstacles: '0', stands: '', seed: '' }), 'obstacles:0');
  assert.equal(composeMapExtra({ mode: 'fixed', obstacles: 'fixed', stands: 'random', seed: '7' }), 'obstacles:fixed stands:random seed:7');
});

test('empty line-ups are rejected and specs are validated', () => {
  assert.throws(() => composeGroups({ mode: 'both', red: { smart: 0 }, blue: { smart: 0 }, map: {} }), /至少需要一名 bot/);
  assert.throws(() => parseTeamSpec('2:wizard'), /无效的队伍参数/);
  assert.deepEqual(parseTeamSpec('2:smart, 1:simple'), { smart: 2, simple: 1, jump: 0, py: 0 });
  assert.deepEqual(parseTeamSpec('1:jump'), { smart: 0, simple: 0, jump: 1, py: 0 });
  assert.deepEqual(parseTeamSpec('1:py'), { smart: 0, simple: 0, jump: 0, py: 1 });
});

test('jump style spawns with the J prefix', () => {
  const groups = composeGroups({
    mode: 'both',
    red: { smart: 0, simple: 0, jump: 2 },
    blue: { smart: 1, simple: 0, jump: 0 },
    map: { mode: 'fixed' }
  });
  assert.deepEqual(groups.map(g => g.env.CTF_NAME_PREFIX), ['RJ', 'BS']);
  assert.ok(groups[0].script.includes('jump_smart_bot_test.js'));
});

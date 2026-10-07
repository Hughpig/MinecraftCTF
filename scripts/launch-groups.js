// Shared launch-group composition for the CLI launcher and the viewer panel.
// Turns a launch config into per-(team, style) bot process groups so mixed
// teams (e.g. red 2 walk-smart + 1 simple) spawn the right scripts with
// pinned sides and disjoint usernames.

const path = require('node:path');

const SCRIPTS = {
  smart: { script: 'walk_smart_bot_test.js', runner: 'node' },
  simple: { script: 'local_bot_test.js', runner: 'node' },
  jump: { script: 'jump_smart_bot_test.js', runner: 'node' },
  spark: { script: 'spark_bot_test.js', runner: 'node' },
  py: { script: 'python/ctf_bot.py', runner: 'python' },
  pyjump: { script: 'python/mf_jump_bot.py', runner: 'python-bridge' }
};
const STYLE_LETTERS = { smart: 'S', simple: 'X', jump: 'J', spark: 'K', py: 'P', pyjump: 'Y' };
const STYLES = Object.keys(SCRIPTS);

// Node styles run under the current node binary; the python style needs a
// python interpreter — prefer `python`, fall back to the Windows launcher.
function pythonCommand() {
  for (const candidate of ['python', 'python3', 'py']) {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (_) { /* try the next one */ }
  }
  throw new Error('未找到可用的 Python 解释器（python/python3/py），无法启动 py 风格 bot。');
}

// The JSPyBridge style (pyjump) needs a venv with the `javascript` package;
// bootstrap bot-test/python/.venv on first use, then reuse it.
function pybridgeCommand(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const venvDir = path.join(root, 'bot-test', 'python', '.venv');
  const python = pythonCommand();
  const venvPython = path.join(venvDir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
  if (!fs.existsSync(venvPython)) {
    const { execFileSync } = require('node:child_process');
    console.error('[pybridge] 首次使用：正在创建 venv 并安装 JSPyBridge（需要几分钟）…');
    execFileSync(python, ['-m', 'venv', venvDir], { stdio: 'inherit' });
    execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'javascript'], { stdio: 'inherit' });
  }
  return venvPython;
}

function commandFor(style, root) {
  const entry = SCRIPTS[style];
  const script = require('node:path').join(root, 'bot-test', entry.script);
  if (entry.runner === 'python') return { command: pythonCommand(), args: [script] };
  if (entry.runner === 'python-bridge') return { command: pybridgeCommand(root), args: [script] };
  return { command: process.execPath, args: [script] };
}

function parseTeamSpec(spec) {
  // "2:smart,1:simple,1:jump" -> {smart: 2, simple: 1, jump: 1}
  const counts = { smart: 0, simple: 0, jump: 0, spark: 0, py: 0, pyjump: 0 };
  for (const part of String(spec || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+):(smart|simple|jump|spark|py|pyjump)$/i);
    if (!match) throw new Error(`无效的队伍参数 "${trimmed}"，格式为 数量:smart|jump|spark|simple|py|pyjump，例如 2:smart,1:pyjump`);
    counts[match[2].toLowerCase()] += Number(match[1]);
  }
  return counts;
}

function composeMapExtra(map) {
  const parts = [];
  if (map.obstacles) parts.push(`obstacles:${map.obstacles}`);
  if (map.stands && map.stands !== 'fixed') parts.push(`stands:${map.stands}`);
  if (map.seed) parts.push(`seed:${map.seed}`);
  return parts.join(' ');
}

// config: {
//   mode: 'both' | 'red',
//   red: {smart, simple}, blue: {smart, simple},
//   map: {mode, obstacles, stands, seed}
// }
function composeGroups(config) {
  const teams = config.mode === 'red'
    ? [['left', config.red]]
    : [['left', config.red], ['right', config.blue]];
  const totals = teams.map(([, counts]) => STYLES.reduce((sum, style) => sum + (counts[style] || 0), 0));
  if (totals.some(total => total <= 0)) throw new Error('至少需要一名 bot 才能开局');
  const players = Math.min(...totals);
  const mapExtra = composeMapExtra(config.map || {});
  const enemy = config.mode === 'red' ? 'none' : 'bot';
  const groups = [];
  let first = true;
  for (const [side, counts] of teams) {
    for (const style of STYLES) {
      const count = counts[style] || 0;
      if (count <= 0) continue;
      const prefix = `${side === 'left' ? 'R' : 'B'}${STYLE_LETTERS[style]}`;
      groups.push({
        side,
        style,
        count,
        script: SCRIPTS[style].script,
        runner: SCRIPTS[style].runner,
        label: `${side}-${style}`,
        env: {
          CTF_BOTS: String(count),
          CTF_PLAYERS: String(players),
          CTF_TEAM_SIDE: side,
          CTF_ACTIVE_TEAM: side,
          CTF_NAME_PREFIX: prefix,
          CTF_MAP_MODE: (config.map && config.map.mode) || 'fixed',
          CTF_MATCH_EXTRA: mapExtra,
          CTF_ENEMY: enemy,
          CTF_SETUP: first ? '1' : '0'
        }
      });
      first = false;
    }
  }
  return groups;
}

function scriptPath(root, style) {
  return commandFor(style, root).args[0];
}

module.exports = { SCRIPTS, STYLES, parseTeamSpec, composeGroups, composeMapExtra, scriptPath, commandFor, pythonCommand };

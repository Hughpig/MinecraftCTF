#!/usr/bin/env node
// Command-line match launcher. Composes launch groups from the arguments and
// spawns one bot-test process per (team, style) group.
//
//   node scripts/launch-match.js --red 2:smart,1:simple --blue 3:smart \
//     --map random --obstacles random --stands random --seed 42
//   node scripts/launch-match.js --red 2:smart --enemy none
const { spawn } = require('node:child_process');
const path = require('node:path');
const { composeGroups, parseTeamSpec, scriptPath } = require('./launch-groups');

const root = path.resolve(__dirname, '..');
const children = [];
let stopping = false;

function parseArgs(argv) {
  const args = {
    red: '3:smart',
    blue: '3:smart',
    enemy: 'bot',
    map: { mode: 'fixed', obstacles: '', stands: '', seed: '' }
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case '--red': args.red = value; i++; break;
      case '--blue': args.blue = value; i++; break;
      case '--enemy': args.enemy = value; i++; break;
      case '--map': args.map.mode = value; i++; break;
      case '--obstacles': args.map.obstacles = value; i++; break;
      case '--stands': args.map.stands = value; i++; break;
      case '--seed': args.map.seed = value; i++; break;
      default: throw new Error(`未知参数 ${key}，支持 --red --blue --enemy --map --obstacles --stands --seed`);
    }
  }
  return args;
}

let config;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.enemy !== 'none' && args.enemy !== 'bot') throw new Error('--enemy 只支持 bot 或 none');
  config = {
    mode: args.enemy === 'none' ? 'red' : 'both',
    red: parseTeamSpec(args.red),
    blue: parseTeamSpec(args.blue),
    map: args.map
  };
} catch (error) {
  console.error(`[launch] ${error.message}`);
  process.exit(2);
}

let groups;
try {
  groups = composeGroups(config);
} catch (error) {
  console.error(`[launch] ${error.message}`);
  process.exit(2);
}

for (const group of groups) {
  console.log(`[launch] ${group.label}: ${group.count} bot(s), env CTF_MATCH_EXTRA="${group.env.CTF_MATCH_EXTRA}"`);
  const child = spawn(process.execPath, [scriptPath(root, group.style)], {
    cwd: path.join(root, 'bot-test'),
    env: { ...process.env, ...group.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const prefix = `[${group.label}]`;
  const forward = chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => console.log(`${prefix} ${line}`));
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.on('close', code => {
    console.log(`[launch] ${group.label} exited with ${code}`);
    if (code !== 0 && !stopping) process.exitCode = 1;
  });
  children.push(child);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopAll);
process.once('exit', stopAll);

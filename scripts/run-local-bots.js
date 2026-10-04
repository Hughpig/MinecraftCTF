const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const children = [];
let stopping = false;
const child = spawn(process.execPath, [path.join(root, 'bot-test', 'local_bot_test.js')], {
  cwd: path.join(root, 'bot-test'),
  env: {
    ...process.env,
    CTF_HOST: process.env.CTF_HOST || '127.0.0.1',
    CTF_PORT: process.env.CTF_PORT || '25565',
    CTF_BOTS: process.env.CTF_BOTS || '6',
    CTF_PLAYERS: process.env.CTF_PLAYERS || '3',
    CTF_ACTIVE_TEAM: process.env.CTF_ACTIVE_TEAM || 'both'
  },
  stdio: 'inherit'
});
children.push(child);

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopAll);
process.once('exit', stopAll);

let remaining = children.length;
let failed = false;
for (const child of children) {
  child.once('exit', code => {
    if (code && code !== 0) failed = true;
    remaining -= 1;
    if (remaining === 0) process.exitCode = failed ? 1 : 0;
  });
}

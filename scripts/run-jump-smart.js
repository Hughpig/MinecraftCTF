const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(root, 'bot-test', 'jump_smart_bot_test.js')], {
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

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
process.once('exit', stop);
child.once('exit', code => { process.exitCode = code || 0; });

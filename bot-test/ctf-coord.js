// [CTFC] team chat protocol shared by the jump-smart bots: cross-process
// coordination over plain chat. Every player's chat is relayed by the server,
// so bot processes (and languages) that never share memory can still agree on
// flag claims and rescue duty. Messages are teammate-filtered and idempotent —
// each listener applies the same transition, so delivery order does not matter.
//
//   c <x>,<z>   claim the enemy flag at that block (short lease, like claims)
//   u <x>,<z>   release that claim early (picked up, vanished, gave up)
//   r <name>    I am taking the rescue — one in-flight rescue per team covers
//               the whole door, because one plate press frees every prisoner
//   f           team freed (door opened): clear jailed entries + rescue duty
const CHAT_PREFIX = '[CTFC]';

// "<sender> [CTFC] c 14,-22" -> { sender, command: 'c', arg: '14,-22' }.
// Everything else parses to null: system broadcasts have no <sender>, own
// lines are dropped, and opponents' lines fail the teammate check.
function parseCoordination(message, username, teammates) {
  if (!message || !message.includes(CHAT_PREFIX)) return null;
  const match = /^<(.+?)>\s*(.*)$/.exec(message);
  if (!match) return null;
  const sender = match[1];
  const rest = match[2];
  if (sender === username || !rest.startsWith(CHAT_PREFIX)) return null;
  const parts = rest.slice(CHAT_PREFIX.length).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !teammates || !teammates.has(sender)) return null;
  return { sender, command: parts[0], arg: parts[1] || '' };
}

// Claim keys are rounded block coordinates so the Node and Python banner
// scans (independent implementations) agree on the same key.
const claimKey = (x, z) => `${Math.round(x)},${Math.round(z)}`;
const claimMessage = key => `c ${key}`;
const unclaimMessage = key => `u ${key}`;
const rescueMessage = name => `r ${name}`;
const freedMessage = () => 'f';

module.exports = {
  CHAT_PREFIX, parseCoordination,
  claimKey, claimMessage, unclaimMessage, rescueMessage, freedMessage
};

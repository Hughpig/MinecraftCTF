const canvas = document.getElementById('arena');
const context = canvas.getContext('2d');
const elements = Object.fromEntries([
  'connection-dot', 'connection-text', 'left-score', 'right-score', 'left-progress', 'right-progress',
  'phase', 'timer', 'result-text', 'perspective-badge', 'perspective-title', 'red-view', 'blue-view',
  'show-labels', 'map-overlay', 'overlay-title', 'overlay-text', 'hover-info', 'snapshot-age',
  'start-demo', 'demo-status', 'player-list', 'player-count', 'event-list'
].map(id => [id, document.getElementById(id)]));
const colors = { left: '#f24d62', right: '#2689ee', spectator: '#8994a6' };
const teamNames = { left: '红队', right: '蓝队', spectator: '观战者' };
let envelope = { connected: false, snapshot: null, demo: { status: 'idle' } };
let perspective = 'left';
let gatewayConnected = false;
let previousPlayers = new Map();
let receivedAt = 0;
let token = '';
let demoPending = false;
let demoError = '';
let width = 0;
let height = 0;
let geometry = null;
let lastRoster = '';
let lastEvents = '';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function connected() {
  return gatewayConnected && envelope.connected && envelope.snapshot && Date.now() - envelope.snapshot.updatedAt < 3000;
}

function progress(element, score) {
  element.replaceChildren(...Array.from({ length: 8 }, (_, index) => node('i', index < score ? 'filled' : '')));
}

function describeEvent(entry) {
  const data = entry.data || {};
  const team = teamNames[data.team] || '';
  switch (entry.event) {
    case 'map_setup': return '固定地图已生成';
    case 'lobby_join': return `${data.player} 加入${team}`;
    case 'ready_prompt': return '人数已满足，等待准备';
    case 'match_start': return '比赛开始 · 180 秒倒计时';
    case 'flag_pickup': return `${data.player} 夺取${teamNames[data.owner] || '敌方'}旗`;
    case 'flag_capture': return `${team}插旗 ${data.score}/8 · ${data.player}`;
    case 'jail': return `${data.victim} 被抓捕，进入监狱`;
    case 'release': return `${data.player} 获释`;
    case 'flag_reset': return `${data.player} 的旗已重新立起`;
    case 'match_end': return `比赛结束 ${data.left}:${data.right} · ${data.result === 'draw' ? '平局' : `${teamNames[data.result]}获胜`}`;
    default: return entry.event;
  }
}

function renderRoster(snapshot) {
  const players = snapshot?.players || [];
  const rosterKey = JSON.stringify(players.map(player => [player.id, player.team, player.carrying, player.jailedSeconds, player.ready]));
  if (rosterKey === lastRoster) return;
  lastRoster = rosterKey;
  elements['player-count'].textContent = players.length;
  if (!players.length) {
    elements['player-list'].replaceChildren(node('p', 'empty-message', '暂无玩家进入赛场'));
    return;
  }
  elements['player-list'].replaceChildren(...players.map(player => {
    const row = node('div', 'player-row');
    const color = player.team === 'left' ? 'red' : player.team === 'right' ? 'blue' : 'spectator';
    row.append(node('span', `player-avatar ${color}`, player.team === 'left' ? 'R' : player.team === 'right' ? 'B' : '◉'));
    const identity = node('div', 'player-identity');
    identity.append(node('div', 'player-name', player.name), node('div', 'player-meta', `${teamNames[player.team]} · ${player.jailedSeconds > 0 ? `监禁 ${player.jailedSeconds}s` : snapshot.phase === 'running' ? '比赛中' : player.ready ? '已准备' : '待机'}`));
    row.append(identity);
    if (player.carrying) row.append(node('span', 'player-state', '⚑ 携旗'));
    return row;
  }));
}

function renderEvents(snapshot) {
  const events = (snapshot?.events || []).slice(-12).reverse();
  const eventKey = JSON.stringify(events);
  if (eventKey === lastEvents) return;
  lastEvents = eventKey;
  if (!events.length) {
    elements['event-list'].replaceChildren(node('p', 'empty-message', '等待开局事件'));
    return;
  }
  elements['event-list'].replaceChildren(...events.map(entry => {
    const row = node('div', 'event-row');
    const content = node('div');
    content.append(node('div', 'event-message', describeEvent(entry)), node('div', 'event-time', new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })));
    row.append(node('span', `event-marker ${entry.event}`), content);
    return row;
  }));
}

function renderHud() {
  const snapshot = envelope.snapshot;
  const online = connected();
  elements['connection-dot'].classList.toggle('online', !!online);
  elements['connection-text'].textContent = online ? 'Paper 已连接' : gatewayConnected ? 'Paper 未连接' : 'Viewer 正在重连';
  const left = snapshot?.scores?.left || 0;
  const right = snapshot?.scores?.right || 0;
  elements['left-score'].textContent = left;
  elements['right-score'].textContent = right;
  progress(elements['left-progress'], left);
  progress(elements['right-progress'], right);
  const remaining = snapshot?.remainingSeconds ?? 180;
  elements.timer.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  elements.phase.className = `phase ${online && snapshot?.phase === 'running' ? 'running' : ''}`;
  elements.phase.textContent = !online ? '等待连接' : snapshot.phase === 'running' ? '比赛进行中' : snapshot.phase === 'finished' ? '比赛已结束' : '等待比赛';
  elements['result-text'].textContent = snapshot?.phase === 'finished' && snapshot.result ? snapshot.result.result === 'draw' ? '平局 · 可开始下一局' : `${teamNames[snapshot.result.result]}获胜 · ${left}:${right}` : '180 秒 · 插满 8 旗获胜';
  elements['snapshot-age'].textContent = snapshot ? `${online ? '同步' : '上次同步'} ${Math.max(0, (Date.now() - snapshot.updatedAt) / 1000).toFixed(1)}s 前` : '等待快照';
  elements['map-overlay'].classList.toggle('hidden', !!online && snapshot.mapBuilt);
  if (!online) {
    elements['overlay-title'].textContent = snapshot ? '服务端数据已暂停' : '等待服务端数据';
    elements['overlay-text'].textContent = snapshot ? 'Paper 未运行或连接中断。背景保留的是最后一次快照，不是实时画面。' : '请先启动更新后的 Paper 服务端，再点击「开始演示局」。';
  } else if (!snapshot.mapBuilt) {
    elements['overlay-title'].textContent = '服务端已连接，等待生成地图';
    elements['overlay-text'].textContent = '点击「开始演示局」，机器人会生成固定地图并自动开局。';
  }
  const demoRunning = envelope.demo.status === 'running' || demoPending;
  elements['start-demo'].disabled = !online || !token || demoRunning || snapshot?.phase === 'running';
  elements['start-demo'].textContent = demoRunning ? '演示局运行中…' : snapshot?.phase === 'running' ? '比赛正在进行' : '▶ 开始演示局';
  elements['demo-status'].textContent = demoError || (!online ? '先启动 Paper，网页会自动连接。' : demoRunning ? '正在运行真实本地机器人比赛。' : envelope.demo.status === 'succeeded' ? '上一局验证通过，可再次演示。' : envelope.demo.status === 'failed' ? envelope.demo.message : '演示会生成地图；只连接本机服务器。');
  renderRoster(snapshot);
  renderEvents(snapshot);
}

function receive(state) {
  if (state.snapshot?.updatedAt !== envelope.snapshot?.updatedAt) {
    previousPlayers = new Map((envelope.snapshot?.players || []).map(player => [player.id, player]));
    receivedAt = performance.now();
  }
  envelope = state;
  renderHud();
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function position(x, z) {
  let horizontal = z - geometry.minZ;
  let vertical = geometry.maxX - x;
  if (perspective === 'right') {
    horizontal = geometry.columns - horizontal;
    vertical = geometry.rows - vertical;
  }
  return { x: geometry.offsetX + horizontal * geometry.scale, y: geometry.offsetY + vertical * geometry.scale };
}

function cell(x, z, color, border) {
  const center = position(x + 0.5, z + 0.5);
  const size = geometry.scale;
  context.fillStyle = color;
  context.fillRect(center.x - size / 2, center.y - size / 2, size, size);
  if (border) { context.strokeStyle = border; context.lineWidth = .5; context.strokeRect(center.x - size / 2, center.y - size / 2, size, size); }
}

function label(text, point, color, offset = 0) {
  context.font = `${Math.max(9, Math.min(11, geometry.scale * .68))}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  context.textAlign = 'center';
  context.lineWidth = 3;
  context.strokeStyle = '#ffffffed';
  context.strokeText(text, point.x, point.y + offset);
  context.fillStyle = color;
  context.fillText(text, point.x, point.y + offset);
}

function draw() {
  context.clearRect(0, 0, width, height);
  const snapshot = envelope.snapshot;
  const bounds = snapshot?.bounds || { minX: -24, maxX: 24, minZ: -36, maxZ: 36 };
  const columns = bounds.maxZ - bounds.minZ + 1;
  const rows = bounds.maxX - bounds.minX + 1;
  const scale = Math.min(width / (columns + 4), height / (rows + 4));
  geometry = { minZ: bounds.minZ, maxX: bounds.maxX + 1, columns, rows, scale, offsetX: (width - columns * scale) / 2, offsetY: (height - rows * scale) / 2 };
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = perspective === 'left' ? '#fcfdff' : '#fffdfd';
  context.fillRect(geometry.offsetX, geometry.offsetY, columns * scale, rows * scale / 2);
  context.fillStyle = perspective === 'left' ? '#fffdfd' : '#fcfdff';
  context.fillRect(geometry.offsetX, geometry.offsetY + rows * scale / 2, columns * scale, rows * scale / 2);
  context.strokeStyle = '#edf0f3';
  context.lineWidth = .5;
  context.beginPath();
  for (let column = 0; column <= columns; column++) {
    const coordinate = geometry.offsetX + column * scale;
    context.moveTo(coordinate, geometry.offsetY); context.lineTo(coordinate, geometry.offsetY + rows * scale);
  }
  for (let row = 0; row <= rows; row++) {
    const coordinate = geometry.offsetY + row * scale;
    context.moveTo(geometry.offsetX, coordinate); context.lineTo(geometry.offsetX + columns * scale, coordinate);
  }
  context.stroke();
  if (!snapshot?.mapBuilt) { requestAnimationFrame(draw); return; }
  for (const block of snapshot.blocks) cell(block.x, block.z, block.kind === 'divider' ? '#eeeef0' : block.kind === 'door' ? '#a8b3bf' : '#34383f', block.kind === 'divider' ? '#dfdfe2' : '#72747a');
  for (const prison of snapshot.prisons) {
    const point = position(prison.plateX, prison.plateZ);
    const size = Math.max(3, scale * .24);
    context.fillStyle = '#e9c898'; context.strokeStyle = '#b6956f'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(point.x, point.y - size); context.lineTo(point.x + size, point.y); context.lineTo(point.x, point.y + size); context.lineTo(point.x - size, point.y); context.closePath(); context.fill(); context.stroke();
    if (elements['show-labels'].checked) label(`${teamNames[prison.team]}监狱`, position(prison.x, prison.z), '#778399', -scale * 1.6);
  }
  for (const target of snapshot.targets) {
    const point = position(target.x + .5, target.z + .5);
    const size = scale * .69;
    context.fillStyle = target.locked ? colors[target.flagTeam] || '#a0aaba' : '#fff';
    context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    context.strokeStyle = '#efc02e'; context.lineWidth = Math.max(1.6, scale * .16);
    context.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
  }
  for (const flag of snapshot.flags) {
    const point = position(flag.x + .5, flag.z + .5);
    const size = scale * .45;
    context.globalAlpha = flag.status === 'available' ? 1 : flag.status === 'carried' ? .3 : .13;
    context.fillStyle = colors[flag.team];
    context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    context.globalAlpha = 1;
  }
  const blend = Math.min(1, (performance.now() - receivedAt) / 250);
  for (const player of snapshot.players) {
    const previous = previousPlayers.get(player.id);
    const smooth = previous && Math.hypot(previous.x - player.x, previous.z - player.z) < 5 && connected();
    const playerX = smooth ? previous.x + (player.x - previous.x) * blend : player.x;
    const playerZ = smooth ? previous.z + (player.z - previous.z) * blend : player.z;
    if (playerX < bounds.minX || playerX > bounds.maxX + 1 || playerZ < bounds.minZ || playerZ > bounds.maxZ + 1) continue;
    const point = position(playerX, playerZ);
    const radius = Math.max(3, scale * .29);
    if (player.jailedSeconds > 0) {
      context.beginPath(); context.arc(point.x, point.y, radius + 3, 0, Math.PI * 2); context.strokeStyle = '#9c86b9'; context.lineWidth = 1.4; context.setLineDash([2, 2]); context.stroke(); context.setLineDash([]);
    }
    context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fillStyle = colors[player.team] || colors.spectator; context.fill(); context.strokeStyle = 'white'; context.lineWidth = 1.5; context.stroke();
    if (player.carrying) {
      context.strokeStyle = '#d3a527'; context.lineWidth = 1.6; context.beginPath(); context.moveTo(point.x + radius + 2, point.y); context.lineTo(point.x + radius + 2, point.y - radius * 2); context.stroke();
      context.fillStyle = '#f6cd45'; context.fillRect(point.x + radius + 2, point.y - radius * 2, radius * 1.4, radius);
    }
    if (elements['show-labels'].checked) label(player.name, point, colors[player.team] || colors.spectator, -radius - 7);
  }
  requestAnimationFrame(draw);
}

function setPerspective(team) {
  perspective = team;
  elements['perspective-badge'].className = `perspective-badge ${team === 'left' ? 'red' : 'blue'}`;
  elements['perspective-title'].textContent = team === 'left' ? '红队视角 (RED)' : '蓝队视角 (BLUE)';
  for (const [id, active] of [['red-view', team === 'left'], ['blue-view', team === 'right']]) {
    elements[id].classList.toggle('active', active); elements[id].setAttribute('aria-pressed', String(active));
  }
  elements['hover-info'].hidden = true;
}

elements['red-view'].addEventListener('click', () => setPerspective('left'));
elements['blue-view'].addEventListener('click', () => setPerspective('right'));
elements['start-demo'].addEventListener('click', async () => {
  demoPending = true; demoError = ''; renderHud();
  try {
    const response = await fetch('/api/demo', { method: 'POST', headers: { 'X-Viewer-Token': token } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '演示启动失败');
  } catch (error) { demoError = error.message; }
  finally { demoPending = false; renderHud(); }
});
canvas.addEventListener('mousemove', event => {
  if (!geometry || !envelope.snapshot?.mapBuilt) return;
  const rect = canvas.getBoundingClientRect();
  const cursorX = event.clientX - rect.left, cursorY = event.clientY - rect.top;
  const snapshot = envelope.snapshot;
  const objects = [
    ...snapshot.players.map(player => ({ ...player, title: `${player.name} · ${teamNames[player.team]}${player.carrying ? ' · 携旗' : ''}` })),
    ...(snapshot.prisons || []).flatMap(prison => [
      { x: prison.x, z: prison.z, title: `${teamNames[prison.team]}监狱中心` },
      { x: prison.doorX, z: prison.doorZ, title: `${teamNames[prison.team]}监狱门` },
      { x: prison.plateX, z: prison.plateZ, title: `${teamNames[prison.team]}救援压力板` }
    ]),
    ...snapshot.flags.map(flag => ({ ...flag, x: flag.x + .5, z: flag.z + .5, title: `${teamNames[flag.team]}旗 ${flag.id.split('-').at(-1)} · ${flag.status === 'available' ? '可夺取' : flag.status === 'carried' ? '已被携带' : '已插入目标'}` })),
    ...snapshot.targets.map(target => ({ ...target, x: target.x + .5, z: target.z + .5, title: `${teamNames[target.team]}目标 ${target.id.split('-').at(-1)} · ${target.locked ? `已插${teamNames[target.flagTeam] || '敌方'}旗` : '未锁定'}` }))
  ];
  const hovered = objects.find(object => { const point = position(object.x, object.z); return Math.hypot(point.x - cursorX, point.y - cursorY) < Math.max(7, geometry.scale * .55); });
  elements['hover-info'].hidden = !hovered;
  if (hovered) elements['hover-info'].textContent = `${hovered.title}  /  x ${hovered.x.toFixed(1)}, z ${hovered.z.toFixed(1)}`;
});
canvas.addEventListener('mouseleave', () => { elements['hover-info'].hidden = true; });

const stream = new EventSource('/api/stream');
stream.onopen = async () => {
  gatewayConnected = true;
  try { token = (await (await fetch('/api/session')).json()).token; } catch { token = ''; }
  renderHud();
};
stream.onmessage = event => { try { receive(JSON.parse(event.data)); } catch (error) { console.error('Invalid viewer state', error); } };
stream.onerror = () => { gatewayConnected = false; renderHud(); };
new ResizeObserver(resize).observe(canvas);
setInterval(renderHud, 1000);
resize(); renderHud(); requestAnimationFrame(draw);

const canvas = document.getElementById('arena');
const context = canvas.getContext('2d');
const staticCanvas = document.createElement('canvas');
const staticContext = staticCanvas.getContext('2d');
const objectiveCanvas = document.createElement('canvas');
const objectiveContext = objectiveCanvas.getContext('2d');
const interpolationDelay = 300;
const startupBlendDuration = 1000;
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
let playerFrames = [];
let token = '';
let demoPending = false;
let demoError = '';
let width = 0;
let height = 0;
let geometry = null;
let lastRoster = '';
let lastEvents = '';
let staticLayerKey = '';
let staticLayerDirty = true;
let objectiveLayerKey = '';
let objectiveLayerDirty = true;
let pixelRatio = 1;
let phaseChangedAt = 0;
let animationStarted = false;
let lastDrawAt = 0;
let visualPlayers = new Map();
const labelCache = new Map();

function animationNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function setText(element, text) {
  const value = String(text);
  if (element.textContent !== value) element.textContent = value;
}

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
  if (element.dataset.score === String(score)) return;
  element.dataset.score = String(score);
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
  const rosterKey = JSON.stringify([snapshot?.phase, players.map(player => [player.id, player.name, player.team, player.carrying, player.jailedSeconds, player.ready])]);
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
  setText(elements['connection-text'], online ? 'Paper 已连接' : gatewayConnected ? 'Paper 未连接' : 'Viewer 正在重连');
  const left = snapshot?.scores?.left || 0;
  const right = snapshot?.scores?.right || 0;
  setText(elements['left-score'], left);
  setText(elements['right-score'], right);
  progress(elements['left-progress'], left);
  progress(elements['right-progress'], right);
  const remaining = snapshot?.remainingSeconds ?? 180;
  setText(elements.timer, `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`);
  elements.phase.classList.toggle('running', !!online && snapshot?.phase === 'running');
  setText(elements.phase, !online ? '等待连接' : snapshot.phase === 'running' ? '比赛进行中' : snapshot.phase === 'finished' ? '比赛已结束' : '等待比赛');
  setText(elements['result-text'], snapshot?.phase === 'finished' && snapshot.result ? snapshot.result.result === 'draw' ? '平局 · 可开始下一局' : `${teamNames[snapshot.result.result]}获胜 · ${left}:${right}` : '180 秒 · 插满 8 旗获胜');
  setText(elements['snapshot-age'], snapshot ? `${online ? '同步' : '上次同步'} ${Math.max(0, (Date.now() - snapshot.updatedAt) / 1000).toFixed(1)}s 前` : '等待快照');
  elements['map-overlay'].classList.toggle('hidden', !!online && snapshot.mapBuilt);
  if (!online) {
    setText(elements['overlay-title'], snapshot ? '服务端数据已暂停' : '等待服务端数据');
    setText(elements['overlay-text'], snapshot ? 'Paper 未运行或连接中断。背景保留的是最后一次快照，不是实时画面。' : '请先启动更新后的 Paper 服务端，再点击「开始演示局」。');
  } else if (!snapshot.mapBuilt) {
    setText(elements['overlay-title'], '服务端已连接，等待生成地图');
    setText(elements['overlay-text'], '点击「开始演示局」，机器人会生成固定地图并自动开局。');
  }
  const demoRunning = envelope.demo.status === 'running' || demoPending;
  elements['start-demo'].disabled = !online || !token || demoRunning || snapshot?.phase === 'running';
  setText(elements['start-demo'], demoRunning ? '演示局运行中…' : snapshot?.phase === 'running' ? '比赛正在进行' : '▶ 开始演示局');
  setText(elements['demo-status'], demoError || (!online ? '先启动 Paper，网页会自动连接。' : demoRunning ? '正在运行真实本地机器人比赛。' : envelope.demo.status === 'succeeded' ? '上一局验证通过，可再次演示。' : envelope.demo.status === 'failed' ? envelope.demo.message : '演示会生成地图；只连接本机服务器。'));
  renderRoster(snapshot);
  renderEvents(snapshot);
}

function receive(state) {
  if (state.snapshot && state.snapshot.updatedAt !== envelope.snapshot?.updatedAt) {
    const serverTime = state.snapshot.updatedAt;
    const phaseChanged = state.snapshot.phase !== envelope.snapshot?.phase;
    const receivedAt = animationNow();
    if (phaseChanged || (playerFrames.length && (serverTime < playerFrames.at(-1).serverAt || serverTime - playerFrames.at(-1).serverAt > 1000))) {
      playerFrames = [];
      visualPlayers = new Map();
      phaseChangedAt = receivedAt;
    }
    if (!playerFrames.length || serverTime > playerFrames.at(-1).serverAt) {
      // Use browser receive time for animation. Server timestamps describe the
      // snapshot age, but queued SSE/file updates can arrive in one burst; using
      // server time there makes the viewer replay the burst at high speed.
      playerFrames.push({ at: receivedAt, serverAt: serverTime, players: new Map((state.snapshot?.players || []).map(player => [player.id, player])) });
      playerFrames = playerFrames.filter(frame => receivedAt - frame.at < 2000).slice(-16);
    }

    const nextStaticLayerKey = JSON.stringify([
      state.snapshot?.mapBuilt,
      state.snapshot?.mapVersion,
      state.snapshot?.bounds
    ]);
    if (nextStaticLayerKey !== staticLayerKey) {
      staticLayerKey = nextStaticLayerKey;
      staticLayerDirty = true;
    }
    const nextObjectiveLayerKey = JSON.stringify([
      state.snapshot?.targets,
      state.snapshot?.flags,
      (state.snapshot?.prisons || []).map(prison => [prison.team, prison.open])
    ]);
    if (nextObjectiveLayerKey !== objectiveLayerKey) {
      objectiveLayerKey = nextObjectiveLayerKey;
      objectiveLayerDirty = true;
    }
  }
  if (!state.snapshot) {
    playerFrames = [];
    visualPlayers = new Map();
    lastDrawAt = 0;
    staticLayerDirty = true;
    staticLayerKey = '';
    objectiveLayerDirty = true;
    objectiveLayerKey = '';
  }
  envelope = state;
  renderHud();
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  if (width === rect.width && height === rect.height && pixelRatio === nextPixelRatio) return;
  width = rect.width;
  height = rect.height;
  pixelRatio = nextPixelRatio;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  staticCanvas.width = canvas.width;
  staticCanvas.height = canvas.height;
  objectiveCanvas.width = canvas.width;
  objectiveCanvas.height = canvas.height;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  staticContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  objectiveContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  staticLayerDirty = true;
  objectiveLayerDirty = true;
  labelCache.clear();
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

function cell(drawingContext, x, z, color, border) {
  const center = position(x + 0.5, z + 0.5);
  const size = geometry.scale;
  drawingContext.fillStyle = color;
  drawingContext.fillRect(center.x - size / 2, center.y - size / 2, size, size);
  if (border) { drawingContext.strokeStyle = border; drawingContext.lineWidth = .5; drawingContext.strokeRect(center.x - size / 2, center.y - size / 2, size, size); }
}

function label(drawingContext, text, point, color, offset = 0) {
  const fontSize = Math.max(9, Math.min(11, geometry.scale * .68));
  const key = JSON.stringify([text, color, fontSize]);
  let cached = labelCache.get(key);
  if (!cached) {
    if (labelCache.size >= 64) labelCache.clear();
    const sprite = document.createElement('canvas');
    const spriteContext = sprite.getContext('2d');
    const font = `${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    spriteContext.font = font;
    const labelWidth = Math.ceil(spriteContext.measureText(text).width + 6);
    const labelHeight = Math.ceil(fontSize * 1.5 + 6);
    sprite.width = Math.ceil(labelWidth * pixelRatio);
    sprite.height = Math.ceil(labelHeight * pixelRatio);
    spriteContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    spriteContext.font = font;
    spriteContext.textAlign = 'center';
    spriteContext.lineWidth = 3;
    spriteContext.strokeStyle = '#ffffffed';
    spriteContext.strokeText(text, labelWidth / 2, fontSize + 3);
    spriteContext.fillStyle = color;
    spriteContext.fillText(text, labelWidth / 2, fontSize + 3);
    cached = { sprite, width: sprite.width / pixelRatio, height: sprite.height / pixelRatio, offset: fontSize + 3 };
    labelCache.set(key, cached);
  }
  drawingContext.drawImage(cached.sprite, point.x - cached.width / 2, point.y + offset - cached.offset, cached.width, cached.height);
}

function updateGeometry(snapshot) {
  const bounds = snapshot?.bounds || { minX: -24, maxX: 24, minZ: -36, maxZ: 36 };
  const columns = bounds.maxZ - bounds.minZ + 1;
  const rows = bounds.maxX - bounds.minX + 1;
  const scale = Math.min(width / (columns + 4), height / (rows + 4));
  geometry = { minZ: bounds.minZ, maxX: bounds.maxX + 1, columns, rows, scale, offsetX: (width - columns * scale) / 2, offsetY: (height - rows * scale) / 2 };
  return bounds;
}

function renderStaticLayer(snapshot) {
  staticContext.clearRect(0, 0, width, height);
  staticContext.fillStyle = '#ffffff';
  staticContext.fillRect(0, 0, width, height);
  // Keep both sides of the arena on the same neutral white background. Team
  // ownership is already shown by player, flag, and target colors.
  staticContext.fillStyle = '#fcfdff';
  staticContext.fillRect(geometry.offsetX, geometry.offsetY, geometry.columns * geometry.scale, geometry.rows * geometry.scale / 2);
  staticContext.fillStyle = '#fcfdff';
  staticContext.fillRect(geometry.offsetX, geometry.offsetY + geometry.rows * geometry.scale / 2, geometry.columns * geometry.scale, geometry.rows * geometry.scale / 2);
  staticContext.strokeStyle = '#edf0f3';
  staticContext.lineWidth = .5;
  staticContext.beginPath();
  const { columns, rows, scale } = geometry;
  for (let column = 0; column <= columns; column++) {
    const coordinate = geometry.offsetX + column * scale;
    staticContext.moveTo(coordinate, geometry.offsetY); staticContext.lineTo(coordinate, geometry.offsetY + rows * scale);
  }
  for (let row = 0; row <= rows; row++) {
    const coordinate = geometry.offsetY + row * scale;
    staticContext.moveTo(geometry.offsetX, coordinate); staticContext.lineTo(geometry.offsetX + columns * scale, coordinate);
  }
  staticContext.stroke();
  // x=0 is the neutral crossing strip in the arena. Draw it separately from
  // the team backgrounds so spectators can tell when a player is on the line.
  const center = position(0.5, geometry.minZ + 0.5);
  staticContext.fillStyle = '#9aa0a822';
  staticContext.fillRect(geometry.offsetX, center.y - scale / 2, columns * scale, scale);
  staticContext.strokeStyle = '#8c939d';
  staticContext.lineWidth = Math.max(1.5, scale * .12);
  staticContext.setLineDash([4, 3]);
  staticContext.beginPath();
  staticContext.moveTo(geometry.offsetX, center.y);
  staticContext.lineTo(geometry.offsetX + columns * scale, center.y);
  staticContext.stroke();
  staticContext.setLineDash([]);
  if (!snapshot?.mapBuilt) {
    staticLayerDirty = false;
    return;
  }
  for (const block of snapshot.blocks) {
    cell(staticContext, block.x, block.z, block.kind === 'divider' ? '#eeeef0' : block.kind === 'door' ? '#a8b3bf' : '#34383f', block.kind === 'divider' ? '#dfdfe2' : '#72747a');
  }
  for (const prison of snapshot.prisons || []) {
    const point = position(prison.plateX, prison.plateZ);
    const size = Math.max(3, scale * .24);
    staticContext.fillStyle = '#e9c898'; staticContext.strokeStyle = '#b6956f'; staticContext.lineWidth = 1;
    staticContext.beginPath(); staticContext.moveTo(point.x, point.y - size); staticContext.lineTo(point.x + size, point.y); staticContext.lineTo(point.x, point.y + size); staticContext.lineTo(point.x - size, point.y); staticContext.closePath(); staticContext.fill(); staticContext.stroke();
    if (elements['show-labels'].checked) label(staticContext, `${teamNames[prison.team]}监狱`, position(prison.x, prison.z), '#778399', -scale * 1.6);
  }
  staticLayerDirty = false;
}

function interpolationFrames() {
  if (!connected() || playerFrames.length < 2) return null;
  const now = animationNow();
  const latestFrame = playerFrames.at(-1);
  const target = now - interpolationDelay;
  const startupAge = Math.max(0, now - phaseChangedAt - interpolationDelay);
  const startupBlend = phaseChangedAt ? Math.min(1, startupAge / startupBlendDuration) : 1;
  let previousFrame = playerFrames[0];
  let nextFrame = latestFrame;
  if (target <= previousFrame.at) return { previousFrame, nextFrame: previousFrame, blend: 0, latestFrame, startupBlend };
  if (target >= nextFrame.at) return { previousFrame: nextFrame, nextFrame, blend: 0, latestFrame, startupBlend };
  for (let index = 1; index < playerFrames.length; index++) {
    if (playerFrames[index].at >= target) {
      previousFrame = playerFrames[index - 1];
      nextFrame = playerFrames[index];
      break;
    }
  }
  const blend = Math.min(1, Math.max(0, (target - previousFrame.at) / (nextFrame.at - previousFrame.at)));
  return { previousFrame, nextFrame, blend, latestFrame, startupBlend };
}

function renderObjectiveLayer(snapshot) {
  objectiveContext.clearRect(0, 0, width, height);
  for (const prison of snapshot?.prisons || []) {
    if (!prison.open) continue;
    // Erase only an opened door from the cached map layer. The rest of the
    // static map stays untouched when a player is released.
    cell(objectiveContext, prison.doorX, prison.doorZ, '#fcfdff', '#edf0f3');
  }
  if (snapshot?.mapBuilt) renderObjectives(objectiveContext, snapshot);
  objectiveLayerDirty = false;
}

function interpolatedPosition(player, frames) {
  if (!frames) return player;
  const { previousFrame, nextFrame, blend } = frames;
  const previous = previousFrame.players.get(player.id);
  const next = nextFrame.players.get(player.id);
  if (!previous || !next) return player;
  if (Math.hypot(previous.x - next.x, previous.z - next.z) >= 5) return blend < 1 ? previous : next;
  const historical = { x: previous.x + (next.x - previous.x) * blend, z: previous.z + (next.z - previous.z) * blend };
  const latest = frames.latestFrame?.players.get(player.id);
  if (!latest || frames.startupBlend >= 1) return historical;
  if (Math.hypot(historical.x - latest.x, historical.z - latest.z) >= 5) return latest;
  return {
    x: latest.x + (historical.x - latest.x) * frames.startupBlend,
    z: latest.z + (historical.z - latest.z) * frames.startupBlend
  };
}

function smoothPlayerPosition(player, target, deltaSeconds) {
  const status = `${player.jailedSeconds > 0 ? 'jailed' : 'free'}:${player.carrying ? 'carrying' : 'empty'}`;
  let visual = visualPlayers.get(player.id);
  if (!visual || visual.status !== status || Math.hypot(visual.x - target.x, visual.z - target.z) >= 5) {
    visual = { x: target.x, z: target.z, status };
    visualPlayers.set(player.id, visual);
    return visual;
  }
  // Keep visual movement bounded. If rendering or delivery pauses briefly, the
  // next frame follows the new target at a normal walk-like rate instead of
  // fast-forwarding through all accumulated snapshots.
  const distance = Math.hypot(target.x - visual.x, target.z - visual.z);
  const maxStep = 8 * Math.min(0.05, Math.max(0, deltaSeconds));
  if (distance <= maxStep || maxStep === 0) {
    if (maxStep > 0) { visual.x = target.x; visual.z = target.z; }
    return visual;
  }
  visual.x += (target.x - visual.x) / distance * maxStep;
  visual.z += (target.z - visual.z) / distance * maxStep;
  return visual;
}

function renderObjectives(drawingContext, snapshot) {
  const { scale } = geometry;
  for (const target of snapshot.targets) {
    const point = position(target.x + .5, target.z + .5);
    const size = scale * .69;
    drawingContext.fillStyle = target.locked ? colors[target.flagTeam] || '#a0aaba' : '#fff';
    drawingContext.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    drawingContext.strokeStyle = '#efc02e'; drawingContext.lineWidth = Math.max(1.6, scale * .16);
    drawingContext.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
  }
  for (const flag of snapshot.flags) {
    const point = position(flag.x + .5, flag.z + .5);
    const size = scale * .45;
    drawingContext.globalAlpha = flag.status === 'available' ? 1 : flag.status === 'carried' ? .3 : .13;
    drawingContext.fillStyle = colors[flag.team];
    drawingContext.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    drawingContext.globalAlpha = 1;
  }
}

function draw() {
  const snapshot = envelope.snapshot;
  const bounds = snapshot?.bounds || { minX: -24, maxX: 24, minZ: -36, maxZ: 36 };
  if (staticLayerDirty) {
    updateGeometry(snapshot);
    renderStaticLayer(snapshot);
  }
  const { scale } = geometry;
  context.clearRect(0, 0, width, height);
  context.drawImage(staticCanvas, 0, 0, width, height);
  if (!snapshot?.mapBuilt) { requestAnimationFrame(draw); return; }
  if (objectiveLayerDirty) renderObjectiveLayer(snapshot);
  context.drawImage(objectiveCanvas, 0, 0, width, height);
  const animationTime = animationNow();
  const deltaSeconds = lastDrawAt ? (animationTime - lastDrawAt) / 1000 : 0;
  lastDrawAt = animationTime;
  const frames = interpolationFrames();
  for (const player of snapshot.players) {
    const target = interpolatedPosition(player, frames);
    const interpolated = smoothPlayerPosition(player, target, deltaSeconds);
    const playerX = interpolated.x;
    const playerZ = interpolated.z;
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
    if (elements['show-labels'].checked) label(context, player.name, point, colors[player.team] || colors.spectator, -radius - 7);
  }
  requestAnimationFrame(draw);
}

function setPerspective(team) {
  perspective = team;
  staticLayerDirty = true;
  objectiveLayerDirty = true;
  elements['perspective-badge'].className = `perspective-badge ${team === 'left' ? 'red' : 'blue'}`;
  elements['perspective-title'].textContent = team === 'left' ? '红队视角 (RED)' : '蓝队视角 (BLUE)';
  for (const [id, active] of [['red-view', team === 'left'], ['blue-view', team === 'right']]) {
    elements[id].classList.toggle('active', active); elements[id].setAttribute('aria-pressed', String(active));
  }
  elements['hover-info'].hidden = true;
}

elements['red-view'].addEventListener('click', () => setPerspective('left'));
elements['blue-view'].addEventListener('click', () => setPerspective('right'));
elements['show-labels'].addEventListener('change', () => { staticLayerDirty = true; });
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
function startAnimation() {
  if (animationStarted) return;
  animationStarted = true;
  requestAnimationFrame(draw);
}

resize(); renderHud(); startAnimation();

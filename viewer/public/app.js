const canvas = document.getElementById('arena');
const context = canvas.getContext('2d');
const staticCanvas = document.createElement('canvas');
const staticContext = staticCanvas.getContext('2d');
const objectiveCanvas = document.createElement('canvas');
const objectiveContext = objectiveCanvas.getContext('2d');
let interpolationDelay = 300;
let recentSnapshotGap = 200;
const debugPerformance = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
// ?fps=<10-240> caps the canvas draw loop; without it the loop runs on every
// animation frame the display allows (vertical sync), which is already the
// maximum a browser can present.
const fpsCap = (() => {
  if (typeof location === 'undefined') return 0;
  const raw = new URLSearchParams(location.search).get('fps');
  if (raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(240, Math.max(10, value));
})();
let cachedBlocks = [];
let cachedBlocksKey = '';
const startupBlendDuration = 300;
const teleportDistance = 3;
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
let clockOffset = null;
let lastReceivedAt = 0;
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
let detailsRenderScheduled = false;
let eventKeys = [];

function animationNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function serverClock(serverTime, receivedAt) {
  const sample = receivedAt - serverTime;
  // Late delivery raises the measured offset. Follow a lower latency sample
  // immediately and correct upward slowly to preserve the server's cadence.
  clockOffset = clockOffset === null || sample < clockOffset
    ? sample
    : clockOffset + (sample - clockOffset) * 0.002;
  return serverTime + clockOffset;
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
  const rosterKey = `${snapshot?.phase || ''}|${players.map(player => `${player.id}:${player.name}:${player.team}:${player.carrying}:${player.jailedSeconds}:${player.ready}`).join('|')}`;
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
  const keys = events.map(event => `${event.ts || ''}|${event.event || ''}|${JSON.stringify(event.data || {})}`);
  const eventKey = keys.join('\n');
  if (eventKey === lastEvents) return;
  const list = elements['event-list'];
  const canIncrement = typeof list.insertBefore === 'function' && eventKeys.length > 0
    && keys.length >= eventKeys.length - 1
    && keys.slice(1, eventKeys.length).every((key, index) => key === eventKeys[index]);
  if (canIncrement && keys[0] && keys[0] !== eventKeys[0]) {
    list.insertBefore(createEventRow(events[0]), list.firstChild || null);
    while (list.children.length > 12) list.removeChild(list.lastChild);
    eventKeys = keys;
    lastEvents = eventKey;
    return;
  }
  lastEvents = eventKey;
  eventKeys = keys;
  if (!events.length) {
    list.replaceChildren(node('p', 'empty-message', '等待开局事件'));
    return;
  }
  list.replaceChildren(...events.map(createEventRow));
}

function createEventRow(entry) {
  const row = node('div', 'event-row');
  const content = node('div');
  content.append(node('div', 'event-message', describeEvent(entry)), node('div', 'event-time', new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })));
  row.append(node('span', `event-marker ${entry.event}`), content);
  return row;
}

function scheduleDetailsRender() {
  if (detailsRenderScheduled) return;
  detailsRenderScheduled = true;
  const render = () => {
    detailsRenderScheduled = false;
    const snapshot = envelope.snapshot;
    renderRoster(snapshot);
    renderEvents(snapshot);
  };
  // Keep event and roster DOM work away from the snapshot receive stack. This
  // leaves the next canvas frame free when a flag capture or release arrives.
  setTimeout(render, 75);
}

function objectiveKey(snapshot) {
  const targets = (snapshot?.targets || []).map(target => `${target.id}:${target.locked ? 1 : 0}:${target.flagTeam || ''}`);
  const flags = (snapshot?.flags || []).map(flag => `${flag.id}:${flag.status}:${flag.x}:${flag.z}`);
  const prisons = (snapshot?.prisons || []).map(prison => `${prison.team}:${prison.open ? 1 : 0}`);
  return `${targets.join('|')}||${flags.join('|')}||${prisons.join('|')}`;
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
  scheduleDetailsRender();
}

function receive(state) {
  if (state.snapshot) {
    const key = `${state.snapshot.mapVersion ?? 0}:${state.snapshot.mapBuilt === true}`;
    if (Array.isArray(state.snapshot.blocks)) {
      if (key !== cachedBlocksKey || (cachedBlocks.length === 0 && state.snapshot.blocks.length > 0)) staticLayerDirty = true;
      cachedBlocks = state.snapshot.blocks;
      cachedBlocksKey = key;
    } else {
      state.snapshot.blocks = key === cachedBlocksKey ? cachedBlocks : [];
    }
  }
  if (state.snapshot && state.snapshot.updatedAt !== envelope.snapshot?.updatedAt) {
    const serverTime = state.snapshot.updatedAt;
    const phaseChanged = state.snapshot.phase !== envelope.snapshot?.phase;
    const receivedAt = animationNow();
    const lastFrame = playerFrames.at(-1);
    if (debugPerformance && lastFrame && !phaseChanged && state.snapshot.phase === 'running') {
      const gapRecv = Math.round(receivedAt - lastReceivedAt);
      const gapServer = Math.round(serverTime - lastFrame.serverAt);
      if (gapRecv > 100 || gapServer > 100) console.warn(performance.now() | 0, 'slow snapshot recv', gapRecv, 'server', gapServer, 'snapshotAt', serverTime, 'receivedAt', Date.now());
    }
    if (phaseChanged || (playerFrames.length && (serverTime < playerFrames.at(-1).serverAt || serverTime - playerFrames.at(-1).serverAt > 1000))) {
      playerFrames = [];
      clockOffset = null;
      lastReceivedAt = 0;
      visualPlayers = new Map();
      phaseChangedAt = receivedAt;
    }
    if (!playerFrames.length || serverTime > playerFrames.at(-1).serverAt) {
      const previousFrame = playerFrames.at(-1);
      if (previousFrame) {
        const gap = Math.max(0, receivedAt - lastReceivedAt);
        // Keep enough history to cover a delayed file update, but let the
        // buffer shrink slowly again after the server settles. A short buffer
        // makes normal movement responsive; a long one absorbs event bursts.
        recentSnapshotGap = Math.max(gap, recentSnapshotGap * 0.98);
        interpolationDelay = Math.min(700, Math.max(250, recentSnapshotGap * 1.5));
      }
      const frameAt = serverClock(serverTime, receivedAt);
      lastReceivedAt = receivedAt;
      playerFrames.push({
        at: previousFrame ? Math.max(frameAt, previousFrame.at + 1) : frameAt,
        serverAt: serverTime,
        players: new Map((state.snapshot?.players || []).map(player => [player.id, player]))
      });
      playerFrames = playerFrames.filter(frame => receivedAt - frame.at < 2000).slice(-16);
    }

    const bounds = state.snapshot?.bounds || {};
    const nextStaticLayerKey = `${state.snapshot?.mapBuilt ? 1 : 0}|${state.snapshot?.mapVersion || 0}|${bounds.minX}|${bounds.maxX}|${bounds.minZ}|${bounds.maxZ}`;
    if (nextStaticLayerKey !== staticLayerKey) {
      staticLayerKey = nextStaticLayerKey;
      staticLayerDirty = true;
    }
    const nextObjectiveLayerKey = objectiveKey(state.snapshot);
    if (nextObjectiveLayerKey !== objectiveLayerKey) {
      objectiveLayerKey = nextObjectiveLayerKey;
      objectiveLayerDirty = true;
    }
  }
  if (!state.snapshot) {
    playerFrames = [];
    clockOffset = null;
    lastReceivedAt = 0;
    visualPlayers = new Map();
    lastDrawAt = 0;
    staticLayerDirty = true;
    staticLayerKey = '';
    objectiveLayerDirty = true;
    objectiveLayerKey = '';
    eventKeys = [];
    lastEvents = '';
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
  if (target >= nextFrame.at) {
    // The receive stream can briefly go quiet while the player is still
    // moving. Extrapolate only a short, bounded interval from the last two
    // frames; after that, hold the latest authoritative position.
    const gap = Math.min(180, target - nextFrame.at);
    if (gap > 0 && playerFrames.length >= 2) {
      const previous = playerFrames.at(-2);
      const elapsed = nextFrame.at - previous.at;
      if (elapsed > 0) {
        const extrapolation = Math.min(1.5, gap / elapsed);
        const players = new Map();
        for (const [id, player] of nextFrame.players) {
          const old = previous.players.get(id);
          if (!old || Math.hypot(player.x - old.x, player.z - old.z) >= teleportDistance) {
            players.set(id, player);
            continue;
          }
          players.set(id, { ...player, x: player.x + (player.x - old.x) * extrapolation, z: player.z + (player.z - old.z) * extrapolation });
        }
        const projectedFrame = { ...nextFrame, players };
        return { previousFrame: projectedFrame, nextFrame: projectedFrame, blend: 0, latestFrame, startupBlend };
      }
    }
    return { previousFrame: nextFrame, nextFrame, blend: 0, latestFrame, startupBlend };
  }
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
    // The snapshot door position is a precise location, not a block index;
    // floor it so the cell aligns with the cached map layer. A jail in
    // progress seals the doorway into the wall; an open prison shows floor.
    const doorX = Math.floor(prison.doorX);
    const doorZ = Math.floor(prison.doorZ);
    if (prison.open) cell(objectiveContext, doorX, doorZ, '#fcfdff', '#edf0f3');
    else cell(objectiveContext, doorX, doorZ, '#34383f', '#72747a');
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
  if (Math.hypot(previous.x - next.x, previous.z - next.z) >= teleportDistance) return blend < 1 ? previous : next;
  const historical = { x: previous.x + (next.x - previous.x) * blend, z: previous.z + (next.z - previous.z) * blend };
  const latest = frames.latestFrame?.players.get(player.id);
  if (!latest || frames.startupBlend >= 1) return historical;
  if (Math.hypot(historical.x - latest.x, historical.z - latest.z) >= teleportDistance) return latest;
  return {
    x: latest.x + (historical.x - latest.x) * frames.startupBlend,
    z: latest.z + (historical.z - latest.z) * frames.startupBlend
  };
}

function smoothPlayerPosition(player, target, deltaSeconds) {
  let visual = visualPlayers.get(player.id);
  // Gameplay status changes do not move the player. Reset only when the
  // position itself jumps, including the teleport into prison after capture.
  if (!visual || Math.hypot(visual.x - target.x, visual.z - target.z) >= teleportDistance) {
    visual = { x: target.x, z: target.z };
    visualPlayers.set(player.id, visual);
    return visual;
  }
  // Interpolation already removes snapshot stepping. This second pass only
  // absorbs a delayed frame, so use exponential convergence instead of a
  // walk-speed cap that can permanently fall behind the target.
  const k = 1 - Math.exp(-Math.min(0.25, Math.max(0, deltaSeconds)) * 20);
  visual.x += (target.x - visual.x) * k;
  visual.z += (target.z - visual.z) * k;
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
  if (fpsCap > 0 && lastDrawAt && animationNow() - lastDrawAt < 1000 / fpsCap - 1) {
    requestAnimationFrame(draw);
    return;
  }
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
  if (debugPerformance && snapshot.phase === 'running' && deltaSeconds > 0.025) {
    console.warn('slow frame', Math.round(deltaSeconds * 1000), 'ms');
  }
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

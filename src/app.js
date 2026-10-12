import { Game, HEIGHT, WIDTH, PIECES, cellsOf } from './engine.js';
import { requestFor, applyPlan } from './protocol.js';
import { AIClient } from './ai-client.js';
import { setupBenchmark } from './benchmark-ui.js';

const $ = id => document.getElementById(id);
const game = new Game();
const canvas = $('board');
const ctx = canvas.getContext('2d');
const cell = canvas.width / WIDTH;
const shell = $('game-shell');
const palette = { I: '#6ad8ed', O: '#f4cf74', T: '#b19aea', S: '#90cfab', Z: '#ed8e9e', J: '#7eabef', L: '#edb383' };
const pieceNames = { I: '长条', O: '正方形', T: 'T 形', S: 'S 形', Z: 'Z 形', J: 'J 形', L: 'L 形' };
const integer = new Intl.NumberFormat('zh-CN');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const held = new Map();
const preferences = { ghost: true, grid: true, sound: false };
let best = 0;
let bestAtStart = 0;
let audio = null;
let effects = null;
let touchAction = null;
let touchNext = 0;
let previousTime = 0;
let lastUI = '';
let modalResume = false;
let toastUntil = 0;
let mode = 'human';
let pendingMode = null;
let aiClient = null;
let aiEpoch = 0;
let aiBusy = false;
let aiBuffer = null;
let aiError = null;
let aiNextAt = 0;
let aiRequest = 0;
let gameId = crypto.randomUUID();
const bestScores = { human: 0, ai: 0 };

try {
  const storedBest = Number(localStorage.getItem('tetris-lab-best'));
  if (Number.isFinite(storedBest) && storedBest >= 0) best = storedBest;
  bestScores.human = best;
  const storedScores = JSON.parse(localStorage.getItem('tetris-lab-mode-best') || '{}');
  for (const key of ['human', 'ai']) if (Number.isFinite(storedScores[key]) && storedScores[key] >= 0) bestScores[key] = storedScores[key];
  best = bestScores.human;
  const stored = JSON.parse(localStorage.getItem('tetris-lab-settings') || '{}');
  for (const key of Object.keys(preferences)) if (typeof stored?.[key] === 'boolean') preferences[key] = stored[key];
} catch { /* Playing remains available when device storage is disabled. */ }

function persist() {
  try {
    bestScores[mode] = best;
    localStorage.setItem('tetris-lab-best', String(bestScores.human));
    localStorage.setItem('tetris-lab-mode-best', JSON.stringify(bestScores));
    localStorage.setItem('tetris-lab-settings', JSON.stringify(preferences));
  } catch { /* Device storage is optional. */ }
}

function announce(message) { $('announcement').textContent = message; }

function initAudio() {
  if (!preferences.sound) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (Audio) {
      audio ||= new Audio();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
    }
  } catch { audio = null; }
}

function playTone(frequency, duration, delay = 0) {
  if (!preferences.sound || !audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const time = audio.currentTime + delay;
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, time);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(.055, time + .008);
  gain.gain.exponentialRampToValueAtTime(.001, time + duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(time);
  oscillator.stop(time + duration);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}

function clearInput() {
  held.clear();
  touchAction = null;
}

function focusBoard() { shell.focus({ preventScroll: true }); }

function startGame() {
  initAudio();
  bestAtStart = best;
  clearInput();
  effects = null;
  resetAI();
  gameId = crypto.randomUUID();
  game.start();
  previousTime = performance.now();
  processEvents();
  updateUI(true);
  focusBoard();
  announce(mode === 'ai' ? 'AI 游戏开始。可以暂停或调整播放速度。' : '游戏开始。方向键移动与旋转，空格直接落下。');
}

function togglePause() {
  if (game.status === 'playing') {
    game.pause();
    clearInput();
    announce('游戏已暂停。');
  } else if (game.status === 'paused') {
    aiError = null;
    game.resume();
    previousTime = performance.now();
    announce('继续游戏。');
  }
  updateUI(true);
  focusBoard();
}

function openDialog(id) {
  clearInput();
  modalResume = game.status === 'playing';
  if (modalResume) game.pause();
  updateUI(true);
  $(id).showModal();
  updateUI(true);
}

function restart() {
  if (game.status === 'ready') return;
  if (game.status === 'over') {
    game.reset();
    startGame();
  } else openDialog('restart-dialog');
}

function runAction(action) {
  initAudio();
  if (mode !== 'human' || game.status !== 'playing' || effects?.until > performance.now()) return;
  if (action === 'left') game.move(-1);
  if (action === 'right') game.move(1);
  if (action === 'rotate') game.rotate();
  if (action === 'down') {
    game.descend(true);
    game.dropTimer = 0;
  }
  if (action === 'drop') game.hardDrop();
  processEvents();
  updateUI();
}

function showClearToast(event, now) {
  const toast = $('clear-toast');
  const labels = ['一行消除', '双行消除', '三行消除', '四行消除'];
  const label = document.createElement('span');
  label.textContent = labels[event.count - 1];
  const points = document.createElement('small');
  points.textContent = `+${integer.format(event.gained)} 分`;
  toast.replaceChildren(label, points);
  toast.classList.remove('show');
  // The next animation frame restarts the CSS animation without a forced layout read.
  requestAnimationFrame(() => toast.classList.add('show'));
  toastUntil = now + 900;
}

function processEvents() {
  const now = performance.now();
  for (const event of game.drainEvents()) {
    if (event.type === 'lock') playTone(170, .07);
    if (event.type === 'clear') {
      if (!reducedMotion.matches) effects = { ...event, started: now, until: now + 230 };
      showClearToast(event, now);
      announce(`消除 ${event.count} 行，获得 ${event.gained} 分。累计消除 ${game.lines} 行。`);
      [523, 659, 784].forEach((frequency, i) => playTone(frequency, .15, i * .065));
    }
    if (event.type === 'level') announce(`升到第 ${event.level} 级。下落速度加快。`);
    if (event.type === 'gameover') {
      clearInput();
      playTone(230, .22);
      playTone(160, .3, .18);
      announce(`游戏结束。本局 ${integer.format(game.score)} 分，消除 ${game.lines} 行。`);
    }
  }
  if (game.score > best) {
    best = game.score;
    persist();
  }
}

function block(context, x, y, size, type, { ghost = false, alpha = 1 } = {}) {
  const color = palette[type];
  const gap = size * .065;
  const px = x + gap;
  const py = y + gap;
  const dimension = size - gap * 2;
  context.save();
  context.globalAlpha = alpha;
  if (ghost) {
    context.fillStyle = `${color}0c`;
    context.fillRect(px, py, dimension, dimension);
    context.strokeStyle = `${color}a0`;
    context.lineWidth = Math.max(1, size * .045);
    context.strokeRect(px + 1, py + 1, dimension - 2, dimension - 2);
  } else {
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(px, py, dimension, dimension, size * .06);
    context.fill();
    context.fillStyle = '#ffffff35';
    context.fillRect(px + size * .07, py + size * .06, dimension - size * .14, size * .055);
    context.fillStyle = '#0b111c26';
    context.fillRect(px + size * .07, py + dimension - size * .1, dimension - size * .14, size * .045);
  }
  context.restore();
}

const attractRows = [
  [null, null, null, null, null, null, null, null, 'L', null],
  [null, null, 'T', null, null, null, 'S', 'S', 'L', null],
  ['J', 'T', 'T', 'T', null, 'S', 'S', 'L', 'L', null],
  ['J', 'J', 'J', 'I', 'I', 'I', 'I', null, 'O', 'O'],
  ['Z', 'Z', null, 'L', 'L', 'L', 'T', 'T', 'O', 'O'],
  [null, 'Z', 'Z', 'L', null, 'T', 'T', 'J', 'J', 'J'],
];

function drawBoard(now) {
  ctx.fillStyle = '#0d1522';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (preferences.grid) {
    ctx.strokeStyle = '#26334965';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < WIDTH; x++) { ctx.moveTo(x * cell, 0); ctx.lineTo(x * cell, canvas.height); }
    for (let y = 1; y < HEIGHT; y++) { ctx.moveTo(0, y * cell); ctx.lineTo(canvas.width, y * cell); }
    ctx.stroke();
  }
  if (game.status === 'ready') {
    attractRows.forEach((row, y) => row.forEach((type, x) => {
      if (type) block(ctx, x * cell, (HEIGHT - attractRows.length + y) * cell, cell, type, { alpha: .62 });
    }));
    return;
  }
  const clearing = effects && now < effects.until;
  const board = clearing ? effects.board : game.board;
  board.forEach((row, y) => row.forEach((type, x) => {
    if (type) block(ctx, x * cell, y * cell, cell, type);
  }));
  if (clearing) {
    const progress = (now - effects.started) / (effects.until - effects.started);
    ctx.fillStyle = `rgba(230, 249, 255, ${Math.max(0, 1 - progress) * .85})`;
    effects.rows.forEach(y => ctx.fillRect(0, y * cell, canvas.width, cell));
    return;
  }
  if (game.active && game.status !== 'over') {
    const ghost = game.ghost();
    if (preferences.ghost && ghost.y !== game.active.y) {
      cellsOf(ghost).forEach(({ x, y }) => {
        if (y >= 0) block(ctx, x * cell, y * cell, cell, ghost.type, { ghost: true });
      });
    }
    cellsOf(game.active).forEach(({ x, y }) => {
      if (y >= 0) block(ctx, x * cell, y * cell, cell, game.active.type);
    });
  }
}

function drawPreviews() {
  game.bag.peek().forEach((type, index) => {
    const preview = $(`next-${index}`);
    const context = preview.getContext('2d');
    context.clearRect(0, 0, preview.width, preview.height);
    const matrix = PIECES[type];
    const cells = cellsOf({ matrix, x: 0, y: 0 });
    const minX = Math.min(...cells.map(c => c.x));
    const maxX = Math.max(...cells.map(c => c.x));
    const minY = Math.min(...cells.map(c => c.y));
    const maxY = Math.max(...cells.map(c => c.y));
    const size = 33;
    const offsetX = (preview.width - (maxX - minX + 1) * size) / 2;
    const offsetY = (preview.height - (maxY - minY + 1) * size) / 2 + (index === 0 ? 6 : 0);
    cells.forEach(({ x, y }) => block(context, offsetX + (x - minX) * size, offsetY + (y - minY) * size, size, type));
    preview.setAttribute('aria-label', `${index + 1} 号预览：${pieceNames[type]}方块`);
  });
}

function updateUI(force = false) {
  const signature = [mode, game.status, game.score, game.lines, game.pieces, Math.floor(game.elapsed / 1000), best, game.bag.peek().join('')].join('|');
  if (!force && signature === lastUI) return;
  lastUI = signature;
  $('score').textContent = String(game.score).padStart(6, '0');
  $('lines').replaceChildren(document.createTextNode(integer.format(game.lines)));
  const unit = document.createElement('span');
  unit.className = 'stat-unit';
  unit.textContent = '行';
  $('lines').append(unit);
  $('level').textContent = String(game.level).padStart(2, '0');
  $('best-score').textContent = String(best).padStart(6, '0');
  $('pieces').textContent = integer.format(game.pieces);
  const seconds = Math.floor(game.elapsed / 1000);
  $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const progress = game.lines % 10;
  $('level-progress-label').textContent = `${progress} / 10 行`;
  $('level-progress-fill').style.width = `${progress * 10}%`;
  $('level-progress').setAttribute('aria-valuenow', progress);
  shell.dataset.status = game.status;
  shell.dataset.mode = mode;
  const status = { ready: '准备就绪', playing: '游戏进行中', paused: '已暂停', over: '本局结束' }[game.status];
  const dot = document.createElement('i');
  dot.className = 'status-dot';
  dot.setAttribute('aria-hidden', 'true');
  if (game.status === 'paused') dot.style.background = '#f5cb76';
  if (game.status === 'over') dot.style.background = '#ed8e9e';
  $('game-status').replaceChildren(dot, document.createTextNode(status));
  $('pause-button').disabled = ['ready', 'over'].includes(game.status);
  $('restart-button').disabled = game.status === 'ready';
  $('pause-label').textContent = game.status === 'paused' ? '继续' : '暂停';
  $('pause-symbol').textContent = game.status === 'paused' ? '▷' : 'Ⅱ';
  $('board-overlay').hidden = game.status === 'playing' || document.querySelector('dialog[open]') !== null;
  $('overlay-emblem').hidden = game.status !== 'ready';
  if (game.status === 'ready') {
    $('overlay-title').textContent = mode === 'ai' ? '看看 AI 的下一步。' : '下一块，交给你。';
    $('overlay-copy').textContent = mode === 'ai' ? '搜索落点，预判下一块的空间。' : '旋转、移动，让方块恰好归位。';
    $('start-label').textContent = mode === 'ai' ? '开始 AI 演示' : '开始游戏';
    $('overlay-shortcut').textContent = '也可以按 Enter 开始';
  } else if (game.status === 'paused') {
    $('overlay-title').textContent = '休息一下。';
    $('overlay-copy').textContent = aiError ? 'AI 连接需要恢复，请重新连接后继续。' : '你的方块，在这里等你。';
    $('start-label').textContent = '继续游戏';
    $('overlay-shortcut').textContent = '按 P 或 Esc 继续';
  } else if (game.status === 'over') {
    $('overlay-title').textContent = game.score > bestAtStart ? '新的个人纪录！' : '每一局，都是新开始。';
    $('overlay-copy').textContent = `${integer.format(game.score)} 分，消除 ${integer.format(game.lines)} 行。再来一局？`;
    $('start-label').textContent = '再来一局';
    $('overlay-shortcut').textContent = '也可以按 Enter 重新开始';
  }
  drawPreviews();
}

function updatePreferences() {
  for (const key of ['ghost', 'grid', 'sound']) $(`${key}-setting`).checked = preferences[key];
  $('sound-button').setAttribute('aria-pressed', String(preferences.sound));
  const label = preferences.sound ? '关闭音效' : '开启音效';
  $('sound-button').setAttribute('aria-label', label);
  $('sound-button').title = label;
  $('sound-wave').setAttribute('d', preferences.sound ? 'M16 7a7 7 0 0 1 0 10m-2-7a3 3 0 0 1 0 4' : 'm16 9 5 6m0-6-5 6');
  persist();
}

$('start-button').addEventListener('click', () => {
  if (game.status === 'ready') startGame();
  else if (game.status === 'paused') togglePause();
  else if (game.status === 'over') restart();
});

function resetAI() {
  aiEpoch++;
  aiBuffer = null;
  aiBusy = false;
  aiError = null;
  aiNextAt = 0;
  const previous = aiClient;
  aiClient = null;
  previous?.close();
}

function getAIClient() {
  if (aiClient) return aiClient;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ai`;
  const client = new AIClient(url, state => {
    if (aiClient !== client) return;
    $('ai-connection').dataset.state = state;
    $('ai-connection').textContent = { connected: '已连接', connecting: '连接中…', offline: '未连接' }[state];
  });
  aiClient = client;
  return client;
}

function changeMode(nextMode) {
  if (nextMode === mode) return;
  persist();
  mode = nextMode;
  resetAI();
  best = bestScores[mode];
  game.reset();
  clearInput();
  effects = null;
  $('clear-toast').classList.remove('show');
  document.querySelector('.game-layout').classList.toggle('ai-mode', mode === 'ai');
  $('mode-select').value = mode;
  $('ai-panel').hidden = mode !== 'ai';
  $('human-guide').hidden = mode === 'ai';
  document.querySelector('.board-caption > span:last-child').textContent = mode === 'ai' ? 'AI 自动落子，你也可以随时暂停。' : '专注当下，一块一块来。';
  updateUI(true);
  if (mode === 'ai') {
    const client = getAIClient();
    client.connect().catch(error => { if (aiClient === client) $('ai-message').textContent = error.message; });
  }
  announce(mode === 'ai' ? '已切换到 AI 模式。' : '已切换到人类模式。');
}

function displayDecision(response, request, roundTripMs) {
  const analysis = response.analysis || {};
  $('ai-latency').textContent = `${roundTripMs.toFixed(1)} ms`;
  $('ai-candidates').textContent = analysis.candidates ?? '—';
  $('ai-holes').textContent = analysis.features?.holes ?? '—';
  $('ai-height').textContent = analysis.features?.maxHeight === undefined ? '—' : `${analysis.features.maxHeight} 格`;
  $('ai-message').textContent = `已选择落点。搜索 ${analysis.evaluated ?? '—'} 个局面，消除行数优先于界面分数。`;
  $('ai-protocol').textContent = JSON.stringify({ request: { type: request.type, protocolVersion: request.protocolVersion, gameId: request.gameId, requestId: request.requestId, stateVersion: request.state.stateVersion, provider: request.provider, options: request.options, current: request.state.current, next: request.state.next, board: request.state.board }, response }, null, 2);
}

function consumeAI(buffer) {
  if (buffer.response.type === 'error' && buffer.response.code === 'NO_MOVE') game.end();
  else applyPlan(game, buffer.response, buffer.request);
  displayDecision(buffer.response, buffer.request, buffer.ms);
  processEvents();
  aiNextAt = performance.now() + 1000 / Number($('ai-speed').value);
  updateUI(true);
}

function failAI(error) {
  aiError = error.message;
  $('ai-message').textContent = `AI 已暂停：${error.message}。检查服务后点击重新连接。`;
  game.pause();
  updateUI(true);
  announce('AI 出现连接或动作错误，游戏已暂停。');
}

async function requestAI() {
  const epoch = aiEpoch;
  const request = requestFor(game, gameId, String(++aiRequest), { provider: $('ai-provider').value, depth: Number($('ai-depth').value), beam: 8 });
  aiBusy = true;
  const started = performance.now();
  try {
    const response = await getAIClient().decide(request);
    if (epoch !== aiEpoch || mode !== 'ai' || game.status === 'over' || game.status === 'ready') return;
    const buffer = { response, request, ms: performance.now() - started };
    if (game.status === 'paused') aiBuffer = buffer;
    else consumeAI(buffer);
  } catch (error) {
    if (epoch === aiEpoch && mode === 'ai') failAI(error);
  } finally { if (epoch === aiEpoch) aiBusy = false; }
}

$('mode-select').addEventListener('change', event => {
  const next = event.target.value;
  if (['playing', 'paused'].includes(game.status)) {
    pendingMode = next;
    event.target.value = mode;
    openDialog('mode-dialog');
  } else changeMode(next);
});
$('confirm-mode').addEventListener('click', () => {
  modalResume = false;
  $('mode-dialog').close();
  changeMode(pendingMode);
  pendingMode = null;
});
for (const id of ['ai-depth', 'ai-provider']) $(id).addEventListener('change', () => { resetAI(); $('ai-message').textContent = '将在下一次决策使用新的算法设置。'; });
$('ai-speed').addEventListener('input', event => { $('ai-speed-value').textContent = `${event.target.value} 块 / 秒`; });
$('ai-reconnect').addEventListener('click', async () => {
  const wasError = Boolean(aiError);
  resetAI();
  try {
    await getAIClient().connect();
    $('ai-message').textContent = 'AI 服务已连接。';
    if (wasError && game.status === 'paused') { game.resume(); updateUI(true); }
  } catch (error) { failAI(error); }
});
setupBenchmark(openDialog, announce);
$('pause-button').addEventListener('click', togglePause);
$('restart-button').addEventListener('click', restart);
$('help-button').addEventListener('click', () => openDialog('help-dialog'));
$('settings-button').addEventListener('click', () => openDialog('settings-dialog'));
$('sound-button').addEventListener('click', () => {
  preferences.sound = !preferences.sound;
  updatePreferences();
  initAudio();
  playTone(523, .1);
});
for (const key of ['ghost', 'grid', 'sound']) {
  $(`${key}-setting`).addEventListener('change', event => {
    preferences[key] = event.target.checked;
    updatePreferences();
    if (key === 'sound') { initAudio(); playTone(523, .1); }
  });
}
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => {
    if (modalResume) {
      game.resume();
      previousTime = performance.now();
      focusBoard();
    }
    modalResume = false;
    updateUI(true);
  });
});
$('confirm-restart').addEventListener('click', () => {
  modalResume = false;
  $('restart-dialog').close();
  game.reset();
  $('clear-toast').classList.remove('show');
  startGame();
});

const keyActions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotate', ArrowDown: 'down', Space: 'drop' };
window.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  // Respect native button/link shortcuts; gameplay keys belong to the focused board.
  const onBoard = shell.contains(event.target) || event.target === document.body;
  if (!onBoard) return;
  if (event.code === 'Enter' && ['ready', 'over'].includes(game.status)) {
    event.preventDefault();
    if (!event.repeat) game.status === 'ready' ? startGame() : restart();
    return;
  }
  if (['KeyP', 'Escape'].includes(event.code)) {
    event.preventDefault();
    if (!event.repeat && ['playing', 'paused'].includes(game.status)) togglePause();
    return;
  }
  if (event.code === 'KeyR') {
    event.preventDefault();
    if (!event.repeat) restart();
    return;
  }
  const action = keyActions[event.code];
  if (!action) return;
  event.preventDefault();
  if (mode !== 'human') return;
  if (event.repeat || held.has(event.code) || game.status !== 'playing') return;
  held.set(event.code, { action, next: performance.now() + 170 });
  runAction(action);
});
window.addEventListener('keyup', event => { held.delete(event.code); });

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touchAction = button.dataset.action;
    touchNext = performance.now() + 170;
    runAction(touchAction);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => { touchAction = null; });
  // Keyboard and assistive-technology clicks have no pointerdown event.
  button.addEventListener('click', event => { if (event.detail === 0) runAction(button.dataset.action); });
  button.addEventListener('contextmenu', event => event.preventDefault());
});

function autoPause() {
  clearInput();
  if (game.status === 'playing') {
    game.pause();
    announce('游戏已自动暂停。返回后可以继续。');
    updateUI(true);
  }
}
window.addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

function frame(now) {
  const delta = previousTime ? Math.min(50, now - previousTime) : 0;
  previousTime = now;
  if (effects && now >= effects.until) effects = null;
  if (game.status === 'playing' && !effects) {
    if (mode === 'ai') {
      game.elapsed += delta;
      if (aiBuffer) {
        const buffer = aiBuffer;
        aiBuffer = null;
        try { consumeAI(buffer); } catch (error) { failAI(error); }
      } else if (!aiBusy && !aiError && now >= aiNextAt) requestAI();
    } else {
    for (const state of held.values()) {
      if (['left', 'right'].includes(state.action) && now >= state.next) {
        runAction(state.action);
        state.next = now + 65;
      }
    }
    if (['left', 'right'].includes(touchAction) && now >= touchNext) {
      runAction(touchAction);
      touchNext = now + 65;
    }
    game.tick(delta, held.has('ArrowDown') || touchAction === 'down');
    processEvents();
    }
  }
  if (toastUntil && now >= toastUntil) { $('clear-toast').classList.remove('show'); toastUntil = 0; }
  updateUI();
  drawBoard(now);
  requestAnimationFrame(frame);
}

updatePreferences();
updateUI(true);
requestAnimationFrame(frame);

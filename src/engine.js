// Pure game rules. This module has no DOM, rendering, storage or network dependency.
export const WIDTH = 10;
export const HEIGHT = 20;
export const LOCK_DELAY = 450;
export const PIECES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

export function emptyBoard() {
  return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
}

export function rotateMatrix(matrix) {
  return matrix[0].map((_, x) => matrix.map(row => row[x]).reverse());
}

export function cellsOf(piece) {
  const cells = [];
  piece.matrix.forEach((row, dy) => row.forEach((occupied, dx) => {
    if (occupied) cells.push({ x: piece.x + dx, y: piece.y + dy });
  }));
  return cells;
}

export function collides(board, piece) {
  return cellsOf(piece).some(({ x, y }) => x < 0 || x >= WIDTH || y >= HEIGHT || (y >= 0 && board[y][x] !== null));
}

export function clearFullRows(board) {
  const rows = [];
  board.forEach((row, y) => { if (row.every(cell => cell !== null)) rows.push(y); });
  const remaining = board.filter((_, y) => !rows.includes(y)).map(row => [...row]);
  return { board: [...Array.from({ length: rows.length }, () => Array(WIDTH).fill(null)), ...remaining], rows };
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export class Bag {
  constructor(random = Math.random) {
    this.random = random;
    this.queue = [];
    this.fill();
  }

  fill() {
    while (this.queue.length < 7) {
      const bag = Object.keys(PIECES);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      this.queue.push(...bag);
    }
  }

  next() {
    const type = this.queue.shift();
    this.fill();
    return type;
  }

  peek(count = 3) { return this.queue.slice(0, count); }
}

export class Game {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.reset();
  }

  reset() {
    this.board = emptyBoard();
    this.bag = new Bag(this.random);
    this.active = null;
    this.status = 'ready';
    this.score = 0;
    this.lines = 0;
    this.pieces = 0;
    this.elapsed = 0;
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.version = 0;
    this.events = [];
  }

  get level() { return 1 + Math.floor(this.lines / 10); }
  get interval() { return Math.max(80, 850 * Math.pow(0.82, this.level - 1)); }

  start() {
    if (this.status !== 'ready') return false;
    this.status = 'playing';
    this.spawn();
    return true;
  }

  spawn() {
    const type = this.bag.next();
    const matrix = PIECES[type].map(row => [...row]);
    this.active = { type, matrix, x: Math.floor((WIDTH - matrix.length) / 2), y: 0, rotation: 0 };
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.version++;
    if (collides(this.board, this.active)) this.end();
  }

  end() {
    this.status = 'over';
    this.events.push({ type: 'gameover', score: this.score, lines: this.lines });
  }

  pause() {
    if (this.status !== 'playing') return false;
    this.status = 'paused';
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.status = 'playing';
    return true;
  }

  get grounded() {
    return this.active && collides(this.board, { ...this.active, y: this.active.y + 1 });
  }

  resetLock(wasGrounded) {
    if (wasGrounded && this.lockResets < 15) {
      this.lockTimer = 0;
      this.lockResets++;
    }
    if (!this.grounded) this.lockTimer = 0;
  }

  move(dx) {
    if (this.status !== 'playing' || ![-1, 1].includes(dx)) return false;
    const candidate = { ...this.active, x: this.active.x + dx };
    if (collides(this.board, candidate)) return false;
    const wasGrounded = this.grounded;
    this.active = candidate;
    this.resetLock(wasGrounded);
    this.version++;
    return true;
  }

  rotate() {
    if (this.status !== 'playing') return false;
    if (this.active.type === 'O') return true;
    const matrix = rotateMatrix(this.active.matrix);
    for (const dx of [0, -1, 1, -2, 2]) {
      const candidate = { ...this.active, matrix, x: this.active.x + dx, rotation: (this.active.rotation + 1) % 4 };
      if (!collides(this.board, candidate)) {
        const wasGrounded = this.grounded;
        this.active = candidate;
        this.resetLock(wasGrounded);
        this.version++;
        return true;
      }
    }
    return false;
  }

  descend(soft = false) {
    if (this.status !== 'playing') return false;
    const candidate = { ...this.active, y: this.active.y + 1 };
    if (collides(this.board, candidate)) return false;
    this.active = candidate;
    this.lockTimer = 0;
    if (soft) this.score++;
    this.version++;
    return true;
  }

  ghost() {
    if (!this.active) return null;
    const piece = { ...this.active };
    while (!collides(this.board, { ...piece, y: piece.y + 1 })) piece.y++;
    return piece;
  }

  hardDrop() {
    if (this.status !== 'playing') return false;
    const target = this.ghost();
    const distance = target.y - this.active.y;
    this.score += distance * 2;
    this.active = target;
    this.lock();
    return true;
  }

  lock() {
    if (this.status !== 'playing') return;
    const cells = cellsOf(this.active);
    if (cells.some(({ y }) => y < 0)) {
      this.end();
      return;
    }
    cells.forEach(({ x, y }) => { this.board[y][x] = this.active.type; });
    this.pieces++;
    const before = this.board.map(row => [...row]);
    const result = clearFullRows(this.board);
    const cleared = result.rows.length;
    const oldLevel = this.level;
    const gained = [0, 100, 300, 500, 800][cleared] * oldLevel;
    this.score += gained;
    this.lines += cleared;
    this.board = result.board;
    this.events.push({ type: 'lock', cells, piece: this.active.type });
    if (cleared) this.events.push({ type: 'clear', rows: result.rows, board: before, count: cleared, gained });
    if (this.level > oldLevel) this.events.push({ type: 'level', level: this.level });
    this.spawn();
  }

  tick(ms, soft = false) {
    if (this.status !== 'playing' || !Number.isFinite(ms) || ms <= 0) return;
    // Small substeps keep locking and gravity independent of the render frame rate.
    let remaining = ms;
    while (remaining > 0 && this.status === 'playing') {
      const step = Math.min(remaining, 16);
      remaining -= step;
      this.elapsed += step;
      this.dropTimer += step;
      const interval = soft ? Math.min(40, this.interval) : this.interval;
      while (this.dropTimer >= interval && this.status === 'playing') {
        this.dropTimer -= interval;
        this.descend(soft);
      }
      if (this.grounded) {
        this.lockTimer += step;
        if (this.lockTimer >= LOCK_DELAY) this.lock();
      } else this.lockTimer = 0;
    }
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  snapshot() {
    return {
      protocolVersion: 1,
      stateVersion: this.version,
      width: WIDTH,
      height: HEIGHT,
      board: this.board.map(row => row.map(cell => cell ?? 0)),
      current: this.active ? { ...this.active, matrix: this.active.matrix.map(row => [...row]) } : null,
      next: this.bag.peek(3),
      score: this.score,
      lines: this.lines,
      level: this.level,
      status: this.status,
    };
  }
}

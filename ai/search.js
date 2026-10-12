import { PIECES, WIDTH, HEIGHT, rotateMatrix } from '../src/engine.js';

// Each row is a ten-bit occupancy mask. Colours are irrelevant to the policy.
const FULL = (1 << WIDTH) - 1;
const POP = new Uint8Array(1024);
for (let i = 1; i < POP.length; i++) POP[i] = POP[i >> 1] + (i & 1);
export const DEFAULT_WEIGHTS = Object.freeze({ height: -0.51, lines: 0.76, holes: -1.8, bumpiness: -0.184, maxHeight: -0.1, wells: -0.05 });
export const DEFAULT_OPTIONS = Object.freeze({ depth: 2, beam: 8 });
export const POLICY_VERSION = 'linear-preview-v1';

const shapes = {};
for (const [type, original] of Object.entries(PIECES)) {
  let matrix = original;
  shapes[type] = [];
  for (let rotation = 0; rotation < 4; rotation++) {
    const cells = [];
    matrix.forEach((row, y) => row.forEach((occupied, x) => { if (occupied) cells.push({ x, y }); }));
    const minX = Math.min(...cells.map(c => c.x));
    const maxX = Math.max(...cells.map(c => c.x));
    const bottom = Array(matrix.length).fill(-1);
    cells.forEach(c => { bottom[c.x] = Math.max(bottom[c.x], c.y); });
    const variants = new Map();
    for (let x = -minX; x < WIDTH - maxX; x++) {
      const masks = Array(matrix.length).fill(0);
      cells.forEach(c => { masks[c.y] |= 1 << (x + c.x); });
      variants.set(x, { x, masks, bottom });
    }
    shapes[type].push({ cells, variants, rotation });
    matrix = rotateMatrix(matrix);
  }
}

export function toRows(board) {
  return Uint16Array.from(board, row => row.reduce((mask, cell, x) => mask | (cell && (1 << x)), 0));
}

export function features(rows) {
  const heights = new Int8Array(WIDTH);
  let seen = 0;
  let holes = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const row = rows[y];
    const fresh = row & ~seen;
    if (fresh) for (let x = 0; x < WIDTH; x++) if (fresh & (1 << x)) heights[x] = HEIGHT - y;
    seen |= row;
    holes += POP[seen & ~row & FULL];
  }
  let height = 0;
  let bumpiness = 0;
  let maxHeight = 0;
  let wells = 0;
  for (let x = 0; x < WIDTH; x++) {
    height += heights[x];
    maxHeight = Math.max(maxHeight, heights[x]);
    if (x) bumpiness += Math.abs(heights[x] - heights[x - 1]);
    const depth = Math.min(x ? heights[x - 1] : HEIGHT, x < WIDTH - 1 ? heights[x + 1] : HEIGHT) - heights[x];
    if (depth > 0) wells += depth * (depth + 1) / 2;
  }
  return { height, holes, bumpiness, maxHeight, wells, heights };
}

function fits(rows, variant, y) {
  for (let dy = 0; dy < variant.masks.length; dy++) {
    const mask = variant.masks[dy];
    if (!mask) continue;
    const py = y + dy;
    if (py >= HEIGHT || (py >= 0 && rows[py] & mask)) return false;
  }
  return true;
}

function transition(rows, variant, startY, heights) {
  let y = HEIGHT;
  for (let dx = 0; dx < variant.bottom.length; dx++) {
    if (variant.bottom[dx] >= 0) y = Math.min(y, HEIGHT - heights[variant.x + dx] - 1 - variant.bottom[dx]);
  }
  // A request may arrive below the surface. Never jump a piece through a block.
  if (y < startY) {
    y = startY;
    while (fits(rows, variant, y + 1)) y++;
  }
  if (!fits(rows, variant, y)) return null;
  const result = rows.slice();
  for (let dy = 0; dy < variant.masks.length; dy++) {
    if (!variant.masks[dy]) continue;
    if (y + dy < 0) return null;
    result[y + dy] |= variant.masks[dy];
  }
  let write = HEIGHT - 1;
  let lines = 0;
  for (let read = HEIGHT - 1; read >= 0; read--) {
    if (result[read] === FULL) lines++;
    else result[write--] = result[read];
  }
  while (write >= 0) result[write--] = 0;
  return { rows: result, lines, y };
}

// BFS over legal rotations/horizontal moves at the current height. Each final
// drop has a replayable path. It does not pretend to enumerate floor tucks.
export function placements(rows, type, current = null, withPaths = false) {
  const rotations = shapes[type];
  const start = current || { rotation: 0, x: Math.floor((WIDTH - PIECES[type].length) / 2), y: 0 };
  const first = rotations[start.rotation].variants.get(start.x);
  if (!first || !fits(rows, first, start.y)) return [];
  const queue = [{ rotation: start.rotation, x: start.x, actions: [] }];
  const visited = new Set([`${start.rotation},${start.x}`]);
  const landings = new Set();
  const candidates = [];
  const heights = features(rows).heights;
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    const variant = rotations[node.rotation].variants.get(node.x);
    const placed = transition(rows, variant, start.y, heights);
    if (placed) {
      const key = rotations[node.rotation].cells.map(c => `${node.x + c.x},${placed.y + c.y}`).sort().join('|');
      if (!landings.has(key)) {
        landings.add(key);
        candidates.push({ ...placed, x: node.x, rotation: node.rotation, actions: withPaths ? [...node.actions, 'drop'] : undefined });
      }
    }
    const neighbors = [];
    for (const dx of [-1, 1]) {
      const next = rotations[node.rotation].variants.get(node.x + dx);
      if (next && fits(rows, next, start.y)) neighbors.push({ rotation: node.rotation, x: node.x + dx, action: dx < 0 ? 'left' : 'right' });
    }
    if (type !== 'O') {
      const rotation = (node.rotation + 1) % 4;
      for (const dx of [0, -1, 1, -2, 2]) {
        const next = rotations[rotation].variants.get(node.x + dx);
        if (next && fits(rows, next, start.y)) {
          neighbors.push({ rotation, x: node.x + dx, action: 'rotate' });
          break;
        }
      }
    }
    for (const neighbor of neighbors) {
      const key = `${neighbor.rotation},${neighbor.x}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ rotation: neighbor.rotation, x: neighbor.x, actions: withPaths ? [...node.actions, neighbor.action] : [] });
    }
  }
  return candidates;
}

export function evaluate(rows, weights = DEFAULT_WEIGHTS) {
  const values = features(rows);
  let value = 0;
  for (const name of ['height', 'holes', 'bumpiness', 'maxHeight', 'wells']) value += weights[name] * values[name];
  return value;
}

export function chooseMove(state, options = {}) {
  const started = performance.now();
  const depth = options.depth ?? DEFAULT_OPTIONS.depth;
  const beam = options.beam ?? DEFAULT_OPTIONS.beam;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const rows = toRows(state.board);
  let evaluated = 0;
  const root = placements(rows, state.current.type, state.current, true);
  for (const candidate of root) {
    candidate.value = evaluate(candidate.rows, weights) + weights.lines * candidate.lines;
    evaluated++;
  }
  root.sort((a, b) => b.value - a.value);
  function future(board, previewIndex, remaining) {
    const candidates = placements(board, state.next[previewIndex]);
    for (const candidate of candidates) {
      candidate.value = evaluate(candidate.rows, weights) + weights.lines * candidate.lines;
      evaluated++;
    }
    candidates.sort((a, b) => b.value - a.value);
    if (!candidates.length) return -1e6;
    if (remaining <= 1 || !state.next[previewIndex + 1]) return candidates[0].value;
    let best = -Infinity;
    for (const candidate of candidates.slice(0, Math.min(beam, 4))) best = Math.max(best, weights.lines * candidate.lines + future(candidate.rows, previewIndex + 1, remaining - 1));
    return best;
  }
  let best = null;
  let bestValue = -Infinity;
  for (const candidate of root.slice(0, depth > 1 ? beam : 1)) {
    const value = depth > 1 && state.next.length ? weights.lines * candidate.lines + future(candidate.rows, 0, depth - 1) : candidate.value;
    if (value > bestValue) { best = candidate; bestValue = value; }
  }
  return best ? {
    actions: best.actions,
    target: { x: best.x, y: best.y, rotation: best.rotation },
    analysis: { value: bestValue, candidates: root.length, evaluated, depth, computeMs: performance.now() - started, features: { ...features(best.rows), heights: undefined }, policy: POLICY_VERSION },
  } : null;
}

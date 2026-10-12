import test from 'node:test';
import assert from 'node:assert/strict';
import { Bag, Game, HEIGHT, WIDTH, PIECES, LOCK_DELAY, cellsOf, collides, clearFullRows, emptyBoard, rotateMatrix, seededRandom } from '../src/engine.js';

function playing(seed = 42) {
  const game = new Game({ random: seededRandom(seed) });
  game.start();
  return game;
}

test('every group of seven generated pieces contains all seven shapes; seeds reproduce sequences', () => {
  const a = new Bag(seededRandom(10));
  const b = new Bag(seededRandom(10));
  const sequence = Array.from({ length: 70 }, () => a.next());
  assert.deepEqual(sequence, Array.from({ length: 70 }, () => b.next()));
  for (let i = 0; i < sequence.length; i += 7) assert.equal(new Set(sequence.slice(i, i + 7)).size, 7);
});

test('all shapes have four cells and four rotations restore their original matrix', () => {
  for (const matrix of Object.values(PIECES)) {
    assert.equal(cellsOf({ matrix, x: 0, y: 0 }).length, 4);
    let rotated = matrix;
    for (let i = 0; i < 4; i++) rotated = rotateMatrix(rotated);
    assert.deepEqual(rotated, matrix);
  }
});

test('collision handles both walls, the floor, occupied cells, and cells above the board', () => {
  const board = emptyBoard();
  const square = { type: 'O', matrix: PIECES.O, x: 0, y: 0 };
  assert.equal(collides(board, square), false);
  assert.equal(collides(board, { ...square, x: -1 }), true);
  assert.equal(collides(board, { ...square, x: WIDTH - 1 }), true);
  assert.equal(collides(board, { ...square, y: HEIGHT - 1 }), true);
  assert.equal(collides(board, { ...square, y: -1 }), false);
  board[1][1] = 'T';
  assert.equal(collides(board, square), true);
});

test('clearing two adjacent rows preserves the order of the rows above them', () => {
  const board = emptyBoard();
  board[19].fill('I');
  board[18].fill('O');
  board[17][0] = 'T';
  board[16][1] = 'S';
  const result = clearFullRows(board);
  assert.deepEqual(result.rows, [18, 19]);
  assert.equal(result.board[19][0], 'T');
  assert.equal(result.board[18][1], 'S');
  assert.equal(result.board.length, HEIGHT);
  assert.equal(result.board[0].every(cell => cell === null), true);
  assert.equal(board[19][0], 'I');
});

for (const count of [1, 2, 3, 4]) {
  test(`locking a vertical I clears ${count} lines and scores the correct reward`, () => {
    const game = playing();
    const matrix = rotateMatrix(PIECES.I);
    game.active = { type: 'I', matrix, x: 2, y: HEIGHT - 4, rotation: 1 };
    for (let y = HEIGHT - count; y < HEIGHT; y++) {
      game.board[y].fill('J');
      game.board[y][4] = null;
    }
    game.lock();
    assert.equal(game.lines, count);
    assert.equal(game.score, [0, 100, 300, 500, 800][count]);
    assert.equal(game.pieces, 1);
    assert.equal(game.status, 'playing');
    assert.equal(game.drainEvents().find(event => event.type === 'clear').count, count);
  });
}

test('hard drop lands at the ghost location, adds distance points, and spawns the next piece', () => {
  const game = playing();
  const ghost = game.ghost();
  const expectedScore = (ghost.y - game.active.y) * 2;
  const oldCells = cellsOf(ghost);
  const type = ghost.type;
  const next = game.bag.peek()[0];
  game.hardDrop();
  assert.equal(game.score, expectedScore);
  oldCells.forEach(({ x, y }) => assert.equal(game.board[y][x], type));
  assert.equal(game.active.type, next);
  assert.equal(game.pieces, 1);
});

test('soft drop earns points, gravity does not, and a grounded piece waits before locking', () => {
  const game = playing();
  game.tick(game.interval);
  assert.equal(game.score, 0);
  game.descend(true);
  assert.equal(game.score, 1);
  game.active = game.ghost();
  game.tick(LOCK_DELAY - 1);
  assert.equal(game.pieces, 0);
  game.tick(1);
  assert.equal(game.pieces, 1);
});

test('pause blocks input and time, resume restores play, reset clears session state', () => {
  const game = playing();
  const before = game.snapshot();
  game.pause();
  game.tick(10000);
  assert.equal(game.move(-1), false);
  assert.equal(game.rotate(), false);
  assert.equal(game.hardDrop(), false);
  assert.equal(game.elapsed, 0);
  assert.deepEqual(game.active, before.current);
  game.resume();
  assert.equal(game.move(-1), true);
  game.reset();
  assert.equal(game.status, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.lines, 0);
  assert.equal(game.active, null);
});

test('rotation next to a wall uses horizontal correction without overlapping a block', () => {
  const game = playing();
  game.active = { type: 'I', matrix: rotateMatrix(PIECES.I), x: -2, y: 4, rotation: 1 };
  assert.equal(collides(game.board, game.active), false);
  assert.equal(game.rotate(), true);
  assert.equal(collides(game.board, game.active), false);
  assert.equal(game.active.x, 0);
});

test('an impossible rotation leaves the piece unchanged', () => {
  const game = playing();
  game.active = { type: 'T', matrix: PIECES.T.map(row => [...row]), x: 3, y: 3, rotation: 0 };
  const occupied = new Set(cellsOf(game.active).map(({ x, y }) => `${x},${y}`));
  for (let y = 2; y <= 6; y++) for (let x = 0; x < WIDTH; x++) if (!occupied.has(`${x},${y}`)) game.board[y][x] = 'O';
  const before = structuredClone(game.active);
  assert.equal(game.rotate(), false);
  assert.deepEqual(game.active, before);
});

test('line thresholds raise the level and speed; reward uses the level before clearing', () => {
  const game = playing();
  game.lines = 9;
  game.active = { type: 'I', matrix: PIECES.I, x: 3, y: 18, rotation: 0 };
  game.board[19].fill('T');
  for (let x = 3; x < 7; x++) game.board[19][x] = null;
  const oldInterval = game.interval;
  game.lock();
  assert.equal(game.lines, 10);
  assert.equal(game.level, 2);
  assert.equal(game.score, 100);
  assert.ok(game.interval < oldInterval);
});

test('occupied spawn cells end the game instead of replacing the stack', () => {
  const game = playing();
  game.board[0].fill('Z');
  game.board[1].fill('Z');
  game.spawn();
  assert.equal(game.status, 'over');
  assert.equal(game.board[0].every(cell => cell === 'Z'), true);
  assert.equal(game.drainEvents().at(-1).type, 'gameover');
});

test('snapshot is JSON-compatible and cannot mutate the live board or piece', () => {
  const game = playing();
  const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
  assert.equal(snapshot.board.length, HEIGHT);
  assert.equal(snapshot.board[0].length, WIDTH);
  assert.equal(snapshot.next.length, 3);
  snapshot.board[0][0] = 'O';
  snapshot.current.matrix[0][0] = 9;
  assert.equal(game.board[0][0], null);
  assert.notEqual(game.active.matrix[0][0], 9);
});

test('holding ground movement cannot reset the lock delay more than 15 times', () => {
  const game = playing();
  game.active = { type: 'O', matrix: PIECES.O, x: 4, y: 18, rotation: 0 };
  for (let i = 0; i < 15; i++) {
    game.tick(100);
    game.move(i % 2 ? -1 : 1);
  }
  assert.equal(game.lockResets, 15);
  game.tick(LOCK_DELAY - 1);
  game.move(-1);
  assert.equal(game.lockTimer, LOCK_DELAY - 1);
  game.tick(1);
  assert.equal(game.pieces, 1);
});

test('seeded headless sessions end legally with valid board dimensions', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const game = playing(seed);
    let moves = 0;
    while (game.status === 'playing' && moves < 1000) {
      for (let i = 0; i < seed % 4; i++) game.rotate();
      for (let i = 0; i < moves % 5; i++) game.move(moves % 2 ? -1 : 1);
      assert.equal(collides(game.board, game.active), false);
      game.hardDrop();
      moves++;
    }
    assert.equal(game.status, 'over');
    assert.ok(moves < 1000);
    assert.equal(game.board.length, HEIGHT);
    assert.ok(game.board.every(row => row.length === WIDTH && row.every(cell => cell === null || cell in PIECES)));
  }
});

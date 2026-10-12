import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, seededRandom, emptyBoard, PIECES } from '../src/engine.js';
import { applyPlan, requestFor, responseFor, validateRequest } from '../src/protocol.js';
import { chooseMove, features, placements, toRows } from '../ai/search.js';
import { summarize, runSession } from '../ai/evaluation.js';

function session(seed = 4) { const game = new Game({ random: seededRandom(seed) }); game.start(); return game; }

test('AI features count holes below occupied cells without counting open sky', () => {
  const board = emptyBoard();
  board[17][0] = 'I';
  board[19][0] = 'O';
  board[19][1] = 'O';
  const values = features(toRows(board));
  assert.equal(values.height, 4);
  assert.equal(values.holes, 1);
  assert.equal(values.maxHeight, 3);
});

test('every generated root action path matches the real game engine transition', () => {
  for (const type of Object.keys(PIECES)) {
    const game = session();
    game.active = { type, matrix: PIECES[type].map(row => [...row]), x: Math.floor((10 - PIECES[type].length) / 2), y: 0, rotation: 0 };
    game.board[19][0] = 'J';
    game.board[18][0] = 'J';
    game.board[19][6] = 'S';
    const candidates = placements(toRows(game.snapshot().board), type, game.active, true);
    assert.ok(candidates.length >= 9);
    for (const candidate of candidates) {
      const probe = session();
      probe.board = game.board.map(row => [...row]);
      probe.active = structuredClone(game.active);
      const request = requestFor(probe, 'test', 'move');
      applyPlan(probe, responseFor(request, { actions: candidate.actions, target: { x: candidate.x, y: candidate.y, rotation: candidate.rotation } }), request);
      assert.deepEqual(toRows(probe.snapshot().board), candidate.rows);
      assert.equal(probe.lines, candidate.lines);
    }
  }
});

test('malformed or future-leaking state messages are rejected', () => {
  const request = requestFor(session(), 'test', '1');
  assert.doesNotThrow(() => validateRequest(request));
  for (const mutate of [
    r => { r.state.board.pop(); }, r => { r.state.board[0][0] = 'invalid'; },
    r => { r.state.next.push('I'); }, r => { r.state.current.matrix[0][0] = 7; },
    r => { r.options.depth = 99; }, r => { r.requestId = ''; },
    r => { r.options.weights = { holes: Infinity }; }, r => { r.protocolVersion = 2; },
  ]) {
    const malformed = structuredClone(request);
    mutate(malformed);
    assert.throws(() => validateRequest(malformed));
  }
});

test('wrong ids, stale states, invalid actions and wrong targets cannot partially change a game', () => {
  for (const mutate of [
    r => { r.gameId = 'other'; }, r => { r.stateVersion++; },
    r => { r.actions = ['drop', 'left', 'drop']; }, r => { r.target.y--; },
    r => { r.actions = [...Array(30).fill('left'), 'drop']; },
  ]) {
    const game = session();
    const request = requestFor(game, 'test', '1');
    const response = responseFor(request, chooseMove(request.state));
    mutate(response);
    const before = game.snapshot();
    assert.throws(() => applyPlan(game, response, request));
    assert.deepEqual(game.snapshot(), before);
  }
});

test('pausing during a decision does not allow an action to execute until resumed', () => {
  const game = session();
  const request = requestFor(game, 'test', '1');
  const response = responseFor(request, chooseMove(request.state));
  game.pause();
  assert.throws(() => applyPlan(game, response, request));
  assert.equal(game.pieces, 0);
  game.resume();
  applyPlan(game, response, request);
  assert.equal(game.pieces, 1);
});

test('AI avoids a fatal spawn in lookahead and its long-session transitions remain legal', async () => {
  const result = await runSession(50, { maxPieces: 800 });
  assert.equal(result.pieces, 800);
  assert.ok(result.lines > 250);
  assert.equal(result.status, 'truncated');
});

test('capped sessions are explicit lower bounds, not natural completions', () => {
  const records = [
    { lines: 1200, status: 'truncated', meanDecisionMs: 2, decisions: 20 },
    { lines: 800, status: 'completed', meanDecisionMs: 1, decisions: 10 },
  ];
  const report = summarize(records, { games: 2, options: { depth: 2 } });
  assert.equal(report.meanLines, 1000);
  assert.equal(report.completed, 1);
  assert.equal(report.truncated, 1);
  assert.equal(report.targetEvidence, 'not-demonstrated');
  assert.match(report.interpretation, /lower bound/);
});

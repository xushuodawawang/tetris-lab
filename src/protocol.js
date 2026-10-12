import { Game, PIECES, WIDTH, HEIGHT, rotateMatrix } from './engine.js';

export const PROTOCOL_VERSION = 1;
export const RULES = Object.freeze({ width: WIDTH, height: HEIGHT, randomizer: '7-bag', rotation: 'horizontal-kicks-v1', preview: 3, hold: false, gravity: 'paused-during-ai-decision' });
export const ACTIONS = ['left', 'right', 'rotate', 'down', 'drop'];

function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 100; }
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }

export function validateRequest(message) {
  if (!message || message.type !== 'decide' || message.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported message or protocol version');
  if (!identifier(message.gameId) || !identifier(message.requestId)) throw new Error('Invalid gameId/requestId');
  const state = message.state;
  if (!state || !integer(state.stateVersion, 0, Number.MAX_SAFE_INTEGER) || state.width !== WIDTH || state.height !== HEIGHT || state.status !== 'playing') throw new Error('Invalid state metadata');
  if (!Array.isArray(state.board) || state.board.length !== HEIGHT || state.board.some(row => !Array.isArray(row) || row.length !== WIDTH || row.some(cell => cell !== 0 && !Object.hasOwn(PIECES, cell)))) throw new Error('Invalid board');
  const piece = state.current;
  if (!piece || !Object.hasOwn(PIECES, piece.type) || !integer(piece.x, -4, 13) || !integer(piece.y, -4, 19) || !integer(piece.rotation, 0, 3)) throw new Error('Invalid current piece');
  let expected = PIECES[piece.type];
  for (let i = 0; i < piece.rotation; i++) expected = rotateMatrix(expected);
  if (JSON.stringify(piece.matrix) !== JSON.stringify(expected)) throw new Error('Piece matrix disagrees with type/rotation');
  if (!Array.isArray(state.next) || state.next.length > 3 || state.next.some(type => !Object.hasOwn(PIECES, type))) throw new Error('Invalid preview');
  if (message.provider !== undefined && !['builtin', 'python'].includes(message.provider)) throw new Error('Invalid provider');
  const options = message.options ?? {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error('Invalid options');
  if (options.depth !== undefined && !integer(options.depth, 1, 3)) throw new Error('Invalid search depth');
  if (options.beam !== undefined && !integer(options.beam, 1, 32)) throw new Error('Invalid beam width');
  if (options.weights !== undefined && (typeof options.weights !== 'object' || options.weights === null || Object.entries(options.weights).some(([key, value]) => !['height', 'lines', 'holes', 'bumpiness', 'maxHeight', 'wells'].includes(key) || !Number.isFinite(value) || Math.abs(value) > 100))) throw new Error('Invalid weights');
  return message;
}

export function requestFor(game, gameId, requestId, { provider = 'builtin', ...options } = {}) {
  return { type: 'decide', protocolVersion: PROTOCOL_VERSION, gameId, requestId, provider, state: game.snapshot(), options };
}

export function responseFor(request, move) {
  if (!move) return { type: 'error', protocolVersion: PROTOCOL_VERSION, gameId: request.gameId, requestId: request.requestId, stateVersion: request.state.stateVersion, code: 'NO_MOVE', message: 'No legal move' };
  return { type: 'action', protocolVersion: PROTOCOL_VERSION, gameId: request.gameId, requestId: request.requestId, stateVersion: request.state.stateVersion, ...move };
}

// Validate the entire path on a private probe before changing the live game.
export function applyPlan(game, response, request) {
  if (game.status !== 'playing' || response?.type !== 'action' || response.protocolVersion !== PROTOCOL_VERSION || response.gameId !== request.gameId || response.requestId !== request.requestId || response.stateVersion !== request.state.stateVersion || response.stateVersion !== game.version) throw new Error('Stale or mismatched response');
  const actions = response.actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 200 || actions.at(-1) !== 'drop' || actions.slice(0, -1).includes('drop') || actions.some(action => !ACTIONS.includes(action))) throw new Error('Invalid action sequence');
  const probe = Object.create(Game.prototype);
  Object.assign(probe, { board: game.board.map(row => [...row]), active: { ...game.active, matrix: game.active.matrix.map(row => [...row]) }, status: 'playing', version: game.version, lockTimer: game.lockTimer, lockResets: game.lockResets, score: game.score });
  function perform(target, action) {
    if (action === 'left') return target.move(-1);
    if (action === 'right') return target.move(1);
    if (action === 'rotate') return target.rotate();
    if (action === 'down') return target.descend(false);
  }
  for (const action of actions.slice(0, -1)) if (!perform(probe, action)) throw new Error('Unreachable action');
  const landing = probe.ghost();
  if (!response.target || landing.x !== response.target.x || landing.y !== response.target.y || landing.rotation !== response.target.rotation) throw new Error('Target disagrees with action path');
  for (const action of actions.slice(0, -1)) perform(game, action);
  game.hardDrop();
  return true;
}

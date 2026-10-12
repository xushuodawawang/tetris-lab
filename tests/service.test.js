import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server.js';
import { Game, seededRandom } from '../src/engine.js';
import { connectAI } from '../ai/ws-client.js';
import { requestFor, applyPlan } from '../src/protocol.js';
import { runSession } from '../ai/evaluation.js';

test('real WebSocket sessions exactly reproduce direct decisions, scores and lines', async () => {
  const app = await createApp({ port: 0, evaluations: false });
  try {
    const config = { maxPieces: 200, options: { depth: 2, beam: 8 } };
    const direct = await runSession(345, config);
    const remote = await runSession(345, { ...config, transport: 'websocket', url: `ws://127.0.0.1:${app.port}/ai` });
    for (const key of ['lines', 'score', 'pieces', 'status', 'reason']) assert.equal(remote[key], direct[key]);
  } finally { await app.close(); }
});

test('malformed JSON and an offline external bot return useful errors; next valid request still succeeds', async () => {
  const app = await createApp({ port: 0, evaluations: false });
  const url = `ws://127.0.0.1:${app.port}/ai`;
  const socket = new WebSocket(url);
  try {
    await new Promise(resolve => socket.once('message', resolve));
    const invalid = new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data))));
    socket.send('{');
    assert.equal((await invalid).code, 'INVALID_MESSAGE');
    const client = await connectAI(url);
    const game = new Game({ random: seededRandom(8) });
    game.start();
    await assert.rejects(client.decide(requestFor(game, 'test', 'python', { provider: 'python' })), /BOT_OFFLINE/);
    const request = requestFor(game, 'test', 'builtin');
    applyPlan(game, await client.decide(request), request);
    assert.equal(game.pieces, 1);
    client.close();
  } finally { socket.terminate(); await app.close(); }
});

test('batch evaluation API rejects bad inputs, prevents overlapping jobs and supports cancellation', async () => {
  const app = await createApp({ port: 0 });
  const url = `http://127.0.0.1:${app.port}/api/evaluation`;
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ games: 0 })).status, 400);
    assert.equal((await post({ games: 1, maxPieces: 3000 })).status, 202);
    assert.equal((await post({ games: 1 })).status, 409);
    const stop = await fetch(url, { method: 'DELETE' });
    assert.equal((await stop.json()).status, 'cancelled');
    assert.equal((await (await fetch(url)).json()).status, 'cancelled');
  } finally { await app.close(); }
});

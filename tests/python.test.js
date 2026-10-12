import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createApp } from '../server.js';
import { connectAI } from '../ai/ws-client.js';
import { Game, seededRandom } from '../src/engine.js';
import { requestFor, applyPlan } from '../src/protocol.js';

test('independent Python process plays 60 moves through the WebSocket broker', { timeout: 30000 }, async () => {
  const app = await createApp({ port: 0, evaluations: false });
  const python = spawn(process.env.PYTHON || 'python', ['ai/python_bot.py', '--url', `ws://127.0.0.1:${app.port}/bot`]);
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Python bot startup timed out')), 10000);
      let errors = '';
      python.stderr.on('data', chunk => { errors += chunk; });
      python.once('error', error => { clearTimeout(timeout); reject(error); });
      python.once('exit', code => { clearTimeout(timeout); reject(new Error(`Python bot exited ${code}: ${errors}`)); });
      python.stdout.on('data', chunk => { if (chunk.toString().includes('connected')) { clearTimeout(timeout); resolve(); } });
    });
    client = await connectAI(`ws://127.0.0.1:${app.port}/ai`);
    const game = new Game({ random: seededRandom(600) });
    game.start();
    for (let move = 0; move < 60; move++) {
      const request = requestFor(game, 'python-test', String(move), { provider: 'python', depth: 2, beam: 8 });
      const response = await client.decide(request);
      assert.equal(response.analysis.policy, 'python-linear-preview-v1');
      applyPlan(game, response, request);
      game.drainEvents();
    }
    assert.equal(game.pieces, 60);
    assert.ok(game.lines >= 15);
  } finally { client?.close(); python.kill(); await app.close(); }
});

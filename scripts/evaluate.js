import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runEvaluation, csvFor } from '../ai/evaluation.js';

const args = process.argv.slice(2);
function argument(name, fallback) { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; }
const config = {
  games: Number(argument('games', 200)), startSeed: Number(argument('start-seed', 10000)), maxPieces: Number(argument('max-pieces', 10000)),
  transport: argument('transport', 'websocket'), provider: argument('provider', 'builtin'),
  options: { depth: Number(argument('depth', 2)), beam: Number(argument('beam', 8)) },
};
if (!Number.isInteger(config.games) || config.games < 1 || config.games > 1000 || !Number.isInteger(config.startSeed) || config.startSeed < 0 || !Number.isInteger(config.maxPieces) || config.maxPieces < 0 || ![1, 2, 3].includes(config.options.depth) || !Number.isInteger(config.options.beam) || config.options.beam < 1 || config.options.beam > 32 || !['direct', 'websocket'].includes(config.transport) || !['builtin', 'python'].includes(config.provider) || (config.provider === 'python' && config.transport !== 'websocket')) throw new Error('Invalid evaluation options');
if (argument('weights', null)) config.options.weights = JSON.parse(await readFile(argument('weights'), 'utf8')).weights;
let app;
if (config.transport === 'websocket') {
  config.url = argument('url', null);
  if (!config.url) {
    const { createApp } = await import('../server.js');
    app = await createApp({ port: 0, evaluations: false });
    config.url = `ws://127.0.0.1:${app.port}/ai`;
  }
}
const output = argument('output', 'results/benchmark-200');
await mkdir(path.dirname(output), { recursive: true });
try {
  console.log(`Evaluation: ${JSON.stringify(config)}`);
  const report = await runEvaluation(config, progress => {
    if (progress.record) console.log(`${progress.done}/${progress.games}: seed=${progress.record.seed}, lines=${progress.record.lines}, ${progress.record.status}`);
  });
  await writeFile(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
  await writeFile(`${output}.csv`, csvFor(report));
  const { records, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
} finally { await app?.close(); }

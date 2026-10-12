import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { attachAI } from './ai/service.js';
import { DEFAULT_OPTIONS } from './ai/search.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

export async function createApp({ port = Number(process.env.PORT || 5173), evaluations = true } = {}) {
let evaluation = null;
let evaluationWorker = null;
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/evaluation' && evaluations) {
      if (req.method === 'POST') {
        if (evaluation?.status === 'running') { res.writeHead(409); res.end(JSON.stringify({ error: 'An evaluation is already running' })); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) throw new Error('Request too large'); }
        const input = JSON.parse(body || '{}');
        const config = { games: input.games ?? 200, startSeed: input.startSeed ?? 10000, maxPieces: input.maxPieces ?? 5000, transport: 'websocket', provider: input.provider ?? 'builtin', options: { ...DEFAULT_OPTIONS, depth: input.depth ?? 2 }, url: `ws://127.0.0.1:${server.address().port}/ai` };
        if (!Number.isInteger(config.games) || config.games < 1 || config.games > 200 || !Number.isInteger(config.maxPieces) || config.maxPieces < 3000 || config.maxPieces > 20000 || !Number.isInteger(config.startSeed) || config.startSeed < 0 || !['builtin', 'python'].includes(config.provider) || ![1, 2, 3].includes(config.options.depth)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid evaluation parameters' })); return; }
        evaluation = { id: crypto.randomUUID(), status: 'running', config, done: 0, games: config.games, current: null, startedAt: new Date().toISOString() };
        const job = evaluation;
        evaluationWorker = new Worker(new URL('./ai/evaluation-worker.js', import.meta.url), { workerData: config });
        evaluationWorker.on('message', message => {
          if (message.type === 'progress' && job.status === 'running') Object.assign(job, message.progress);
          if (message.type === 'result' && job.status === 'running') Object.assign(job, { status: 'complete', report: message.report, finishedAt: new Date().toISOString() });
          if (message.type === 'error' && job.status === 'running') Object.assign(job, { status: 'error', error: message.error });
        });
        evaluationWorker.on('error', error => { if (job.status === 'running') Object.assign(job, { status: 'error', error: error.message }); });
        evaluationWorker.on('exit', code => { if (job.status === 'running') Object.assign(job, { status: 'error', error: `Evaluation worker exited (${code})` }); });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(evaluation));
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(evaluation || { status: 'idle' }));
      } else if (req.method === 'DELETE') {
        if (evaluation?.status === 'running') { evaluation.status = 'cancelled'; await evaluationWorker.terminate(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(evaluation || { status: 'idle' }));
      } else { res.writeHead(405); res.end(); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const allowed = relative === 'index.html' || relative === 'styles.css' || relative === 'favicon.svg' || /^src\/[a-z-]+\.js$/.test(relative);
    if (!allowed) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const data = await readFile(path.join(root, relative));
    res.writeHead(200, { 'Content-Type': `${types[path.extname(relative)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
const closeAI = attachAI(server);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
return { server, port: server.address().port, async close() { if (evaluationWorker) await evaluationWorker.terminate(); await closeAI(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(`Tetris Lab: http://localhost:${app.port} (WebSocket: /ai; external bot: /bot)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}

import { Game, seededRandom } from '../src/engine.js';
import { requestFor, responseFor, applyPlan, RULES } from '../src/protocol.js';
import { chooseMove, DEFAULT_WEIGHTS, DEFAULT_OPTIONS, POLICY_VERSION } from './search.js';
import { connectAI } from './ws-client.js';

export async function runSession(seed, { maxPieces = 10000, options = DEFAULT_OPTIONS, transport = 'direct', provider = 'builtin', url, onProgress } = {}) {
  const game = new Game({ random: seededRandom(seed) });
  const client = transport === 'websocket' ? await connectAI(url) : null;
  game.start();
  const gameId = `evaluation-${seed}`;
  let totalMs = 0;
  let computeMs = 0;
  const started = performance.now();
  let decisions = 0;
  try {
    while (game.status === 'playing' && (!maxPieces || game.pieces < maxPieces)) {
      const request = requestFor(game, gameId, `${seed}-${decisions}`, { provider, ...options });
      const before = performance.now();
      const response = client ? await client.decide(request) : responseFor(request, chooseMove(request.state, options));
      totalMs += performance.now() - before;
      computeMs += response.analysis?.computeMs || 0;
      decisions++;
      if (response.type === 'error' && response.code === 'NO_MOVE') { game.end(); break; }
      applyPlan(game, response, request);
      game.drainEvents();
      if (game.pieces % 500 === 0) {
        onProgress?.({ seed, pieces: game.pieces, lines: game.lines });
        if (!client) await new Promise(resolve => setImmediate(resolve));
      }
    }
    return { seed, lines: game.lines, score: game.score, pieces: game.pieces, status: game.status === 'over' ? 'completed' : 'truncated', reason: game.status === 'over' ? 'top-out' : 'piece-limit', decisions, meanDecisionMs: totalMs / decisions, meanComputeMs: computeMs / decisions, seconds: (performance.now() - started) / 1000 };
  } finally { client?.close(); }
}

export function summarize(records, config) {
  const values = records.map(record => record.lines).sort((a, b) => a - b);
  const count = records.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, count - 1));
  const truncated = records.filter(record => record.status === 'truncated').length;
  return {
    createdAt: new Date().toISOString(), policy: POLICY_VERSION, rules: RULES,
    config: { ...config, options: { ...DEFAULT_OPTIONS, ...config.options, weights: { ...DEFAULT_WEIGHTS, ...config.options?.weights } } },
    games: count, completed: count - truncated, truncated,
    meanLines: mean, medianLines: count % 2 ? values[Math.floor(count / 2)] : (values[count / 2 - 1] + values[count / 2]) / 2,
    stdLines: std, minLines: values[0], maxLines: values.at(-1), atLeast1000: records.filter(record => record.lines >= 1000).length,
    interpretation: truncated ? 'Observed mean is a lower bound on full-game mean; capped games are not natural completions.' : 'All games ended naturally.',
    targetEvidence: count === 200 && mean >= 1000 ? (truncated ? 'lower-bound-supported' : 'passed') : 'not-demonstrated',
    meanDecisionMs: records.reduce((sum, record) => sum + record.meanDecisionMs * record.decisions, 0) / records.reduce((sum, record) => sum + record.decisions, 0),
    records,
  };
}

export async function runEvaluation(config, onProgress = () => {}) {
  const records = [];
  for (let index = 0; index < config.games; index++) {
    const seed = config.startSeed + index;
    const record = await runSession(seed, { ...config, onProgress: step => onProgress({ done: index, games: config.games, current: step }) });
    records.push(record);
    onProgress({ done: records.length, games: config.games, record });
  }
  return summarize(records, config);
}

export function csvFor(report) {
  const keys = ['seed', 'lines', 'score', 'pieces', 'status', 'reason', 'decisions', 'meanDecisionMs', 'meanComputeMs', 'seconds'];
  return [keys.join(','), ...report.records.map(record => keys.map(key => record[key]).join(','))].join('\n') + '\n';
}

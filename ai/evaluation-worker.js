import { workerData, parentPort } from 'node:worker_threads';
import { runEvaluation } from './evaluation.js';
try {
  const report = await runEvaluation(workerData, progress => parentPort.postMessage({ type: 'progress', progress }));
  parentPort.postMessage({ type: 'result', report });
} catch (error) { parentPort.postMessage({ type: 'error', error: error.message }); }

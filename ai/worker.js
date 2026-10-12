import { parentPort } from 'node:worker_threads';
import { chooseMove } from './search.js';
import { responseFor } from '../src/protocol.js';

parentPort.on('message', ({ id, request }) => {
  try { parentPort.postMessage({ id, response: responseFor(request, chooseMove(request.state, request.options)) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

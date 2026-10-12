import { Worker } from 'node:worker_threads';
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION, RULES, validateRequest } from '../src/protocol.js';

export function attachAI(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  const pending = new Map();
  let serial = 0;
  let bot = null;
  const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  function finish(id, response) {
    const task = pending.get(id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(id);
    send(task.socket, response);
  }
  function fail(id, code, message) {
    const task = pending.get(id);
    if (!task) return;
    finish(id, { type: 'error', protocolVersion: PROTOCOL_VERSION, gameId: task.request.gameId, requestId: task.request.requestId, code, message });
  }
  worker.on('message', ({ id, response, error }) => error ? fail(id, 'SEARCH_ERROR', error) : finish(id, response));
  worker.on('error', error => { for (const [id, task] of pending) if (task.provider === 'builtin') fail(id, 'WORKER_ERROR', error.message); });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!['/ai', '/bot'].includes(pathname)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, pathname));
  });
  wss.on('connection', (socket, pathname) => {
    socket.on('error', () => {});
    if (pathname === '/bot') {
      if (bot?.readyState === WebSocket.OPEN) { socket.close(1008, 'An external bot is already connected'); return; }
      bot = socket;
      send(socket, { type: 'hello', protocolVersion: PROTOCOL_VERSION, rules: RULES });
    } else send(socket, { type: 'ready', protocolVersion: PROTOCOL_VERSION, rules: RULES, providers: ['builtin', ...(bot?.readyState === WebSocket.OPEN ? ['python'] : [])] });
    socket.on('message', (data, binary) => {
      let message;
      try {
        if (binary) throw new Error('Use JSON text messages');
        message = JSON.parse(data.toString());
        if (pathname === '/bot') {
          if (!['action', 'error'].includes(message.type)) throw new Error('Invalid bot response');
          const task = pending.get(message.brokerId);
          if (!task || task.provider !== 'python') return;
          if (message.gameId !== task.request.gameId || message.requestId !== task.request.requestId || (message.type === 'action' && message.stateVersion !== task.request.state.stateVersion)) throw new Error('Mismatched bot response');
          const { brokerId, ...response } = message;
          finish(brokerId, response);
          return;
        }
        if (message.type === 'ping') { send(socket, { type: 'pong', protocolVersion: PROTOCOL_VERSION, pythonAvailable: bot?.readyState === WebSocket.OPEN }); return; }
        validateRequest(message);
        if ([...pending.values()].some(task => task.socket === socket)) throw new Error('Wait for the current response before requesting another move');
        const provider = message.provider || 'builtin';
        if (provider === 'python' && bot?.readyState !== WebSocket.OPEN) { send(socket, { type: 'error', protocolVersion: PROTOCOL_VERSION, gameId: message.gameId, requestId: message.requestId, code: 'BOT_OFFLINE', message: 'Start the Python bot before using this provider' }); return; }
        const id = ++serial;
        const timer = setTimeout(() => fail(id, 'TIMEOUT', 'AI decision timed out'), 15000);
        pending.set(id, { socket, request: message, timer, provider });
        if (provider === 'python') send(bot, { ...message, brokerId: id });
        else worker.postMessage({ id, request: message });
      } catch (error) {
        if (pathname === '/bot' && message?.brokerId && pending.get(message.brokerId)?.provider === 'python') fail(message.brokerId, 'INVALID_BOT_RESPONSE', error.message);
        send(socket, { type: 'error', protocolVersion: PROTOCOL_VERSION, gameId: message?.gameId, requestId: message?.requestId, code: 'INVALID_MESSAGE', message: error.message });
      }
    });
    socket.on('close', () => {
      if (bot === socket) {
        bot = null;
        for (const [id, task] of pending) if (task.provider === 'python') fail(id, 'BOT_OFFLINE', 'Python bot disconnected');
      }
      for (const [id, task] of pending) if (task.socket === socket) { clearTimeout(task.timer); pending.delete(id); }
    });
  });
  return async () => {
    for (const task of pending.values()) clearTimeout(task.timer);
    for (const client of wss.clients) client.terminate();
    wss.close();
    await worker.terminate();
  };
}

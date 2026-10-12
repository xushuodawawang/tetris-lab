import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/protocol.js';

export async function connectAI(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Connection timed out')); }, 5000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('message', data => {
      clearTimeout(timer);
      try {
        const hello = JSON.parse(data.toString());
        if (hello.type !== 'ready' || hello.protocolVersion !== PROTOCOL_VERSION) throw new Error('Incompatible AI server');
        resolve();
      } catch (error) { socket.terminate(); reject(error); }
    });
  });
  let pending = null;
  function rejectPending(error) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = null;
  }
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('AI connection closed')));
  socket.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (!pending || message.requestId !== pending.request.requestId || message.gameId !== pending.request.gameId) return;
      const task = pending;
      pending = null;
      clearTimeout(task.timer);
      if (message.type === 'error' && message.code !== 'NO_MOVE') task.reject(new Error(`${message.code}: ${message.message}`));
      else task.resolve(message);
    } catch (error) { rejectPending(error); }
  });
  return {
    decide(request) {
      if (pending) return Promise.reject(new Error('A decision is already pending'));
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('AI connection is not open')); return; }
        pending = { request, resolve, reject, timer: setTimeout(() => rejectPending(new Error('AI response timed out')), 16000) };
        socket.send(JSON.stringify(request));
      });
    },
    close() { rejectPending(new Error('Client closed')); socket.close(); },
  };
}

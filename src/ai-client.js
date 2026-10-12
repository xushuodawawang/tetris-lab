import { PROTOCOL_VERSION } from './protocol.js';

export class AIClient {
  constructor(url, onState = () => {}) {
    this.url = url;
    this.onState = onState;
    this.socket = null;
    this.pending = null;
    this.connecting = null;
    this.state = 'offline';
  }

  setState(state) { this.state = state; this.onState(state); }

  async connect() {
    if (this.state === 'connected') return;
    if (this.connecting) return this.connecting;
    this.setState('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('连接超时，请检查服务是否运行')); }, 5000);
      const finish = (error = null) => {
        clearTimeout(timer);
        if (error) { this.setState('offline'); reject(error); }
        else { this.setState('connected'); resolve(); }
      };
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { this.reject(new Error('AI 返回了无效 JSON')); return; }
        if (message.type === 'ready') {
          if (message.protocolVersion !== PROTOCOL_VERSION) finish(new Error('AI 协议版本不匹配'));
          else finish();
          return;
        }
        const task = this.pending;
        if (!task || message.gameId !== task.request.gameId || message.requestId !== task.request.requestId) return;
        this.pending = null;
        clearTimeout(task.timer);
        if (message.type === 'error' && message.code !== 'NO_MOVE') task.reject(new Error(`${message.code}: ${message.message}`));
        else task.resolve(message);
      });
      socket.addEventListener('error', () => finish(new Error('无法连接 AI 服务，请重新连接')));
      socket.addEventListener('close', () => { this.setState('offline'); this.reject(new Error('AI 连接已断开，请重新连接')); finish(new Error('连接已关闭')); });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  reject(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }

  async decide(request) {
    await this.connect();
    if (this.pending) throw new Error('AI 请求正在处理中');
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject, timer: setTimeout(() => this.reject(new Error('AI 决策超时，请重新连接')), 16000) };
      this.socket.send(JSON.stringify(request));
    });
  }

  close() {
    this.reject(new Error('AI 请求已取消'));
    const socket = this.socket;
    if (socket?.readyState === WebSocket.CONNECTING) {
      // Let the handshake finish before closing, avoiding browser warnings when
      // switching modes quickly. The old client is no longer used by the game.
      socket.addEventListener('open', () => socket.close(), { once: true });
    } else socket?.close();
    this.setState('offline');
  }
}

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { imageBytes } from './images.js';
import { splitMarkdown } from './schedule-delivery.js';

/** OneBot v11 forward WebSocket: events and echo-correlated API calls share one socket. */
export class OneBotClient extends EventEmitter {
  constructor({ url, token, requestTimeoutMs = 10000, reconnectMs = 1000, sendIntervalMs = 1100,
    messageMaxBytes = 3800, heartbeatMs = 30000, expectedSelfId = '', WebSocketImpl = WebSocket }) {
    super();
    Object.assign(this, { url, token, requestTimeoutMs, reconnectMs, sendIntervalMs, messageMaxBytes, heartbeatMs, expectedSelfId, WebSocketImpl });
    this.pending = new Map();
    this.sendQueue = Promise.resolve();
    this.ready = false;
    this.stopped = true;
    this.attempt = 0;
    this.lastSent = 0;
  }

  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  open() {
    if (this.stopped) return;
    const socket = this.socket = new this.WebSocketImpl(this.url, {
      headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: this.requestTimeoutMs,
      maxPayload: 1024 * 1024, followRedirects: false,
    });
    socket.on('error', () => this.emit('warning', 'OneBot 连接失败，请检查地址、服务状态和访问令牌。'));
    socket.on('open', async () => {
      let alive = true;
      socket.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, this.heartbeatMs);
      try {
        const login = await this.call('get_login_info');
        if (!/^[1-9]\d*$/.test(String(login?.user_id))) throw new Error('无法获取 QQ 登录身份');
        if (this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
        if (this.expectedSelfId && String(login.user_id) !== this.expectedSelfId) {
          this.emit('warning', `QQ 账号不匹配：已绑定 ${this.expectedSelfId}，当前登录 ${login.user_id}。请登录绑定账号，或停止桥接后运行 npm run login:onebot 重新绑定。`);
          socket.terminate();
          return;
        }
        this.selfId = String(login.user_id);
        this.ready = true;
        this.attempt = 0;
        this.emit('ready', this.selfId);
      } catch {
        this.emit('warning', 'OneBot 登录检查失败，请确认 QQ 已登录且支持 get_login_info。');
        socket.terminate();
      }
    });
    socket.on('message', (data) => {
      let packet;
      try { packet = JSON.parse(data.toString()); } catch { return; }
      if (!packet || typeof packet !== 'object') return;
      const request = this.pending.get(packet.echo);
      if (request) {
        this.pending.delete(packet.echo);
        clearTimeout(request.timer);
        if (packet.status === 'ok' && packet.retcode === 0) request.resolve(packet.data);
        else request.reject(new Error(`OneBot ${request.action} 失败，retcode=${Number.isFinite(packet.retcode) ? packet.retcode : '未知'}`));
      } else if (this.ready && packet.post_type === 'message') {
        if (String(packet.self_id) === this.selfId) this.emit('message', packet);
      }
    });
    socket.on('close', () => {
      clearInterval(this.heartbeat);
      this.ready = false;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('OneBot 连接已断开'));
      }
      this.pending.clear();
      this.emit('disconnected');
      if (!this.stopped) {
        const delay = Math.min(this.reconnectMs * 2 ** Math.min(this.attempt++, 5), 30000);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
      }
    });
  }

  call(action, params = {}) {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 未连接'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        const request = this.pending.get(echo);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(echo);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`OneBot ${action} 响应超时`)), this.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      this.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) fail(new Error(`OneBot ${action} 发送失败`));
      });
    });
  }

  sendMessage(target, content) {
    const match = /^(user|group):([1-9]\d*)$/.exec(target);
    if (!match) return Promise.reject(new Error('无效的 QQ 消息目标'));
    const task = this.sendQueue.then(async () => {
      for (const chunk of splitMarkdown(content, this.messageMaxBytes)) {
        if (!this.ready) throw new Error('QQ 长连接离线');
        const delay = this.sendIntervalMs - (Date.now() - this.lastSent);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!this.ready) throw new Error('QQ 长连接离线');
        this.lastSent = Date.now();
        const group = match[1] === 'group';
        await this.call(group ? 'send_group_msg' : 'send_private_msg', {
          [group ? 'group_id' : 'user_id']: match[2],
          // Text segments prevent model output from injecting CQ actions/@all.
          message: [{ type: 'text', data: { text: chunk } }],
        });
      }
    });
    this.sendQueue = task.catch(() => {});
    return task;
  }

  sendImage(target, image, { signal } = {}) {
    const match = /^(user|group):([1-9]\d*)$/.exec(target);
    if (!match) return Promise.reject(new Error('无效的 QQ 消息目标'));
    const task = this.sendQueue.then(async () => {
      imageBytes(image);
      signal?.throwIfAborted();
      if (!this.ready || this.stopped) throw new Error('QQ 长连接离线');
      const delay = this.sendIntervalMs - (Date.now() - this.lastSent);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      if (!this.ready || this.stopped) throw new Error('QQ 长连接离线');
      this.lastSent = Date.now();
      const group = match[1] === 'group';
      const sent = await this.call(group ? 'send_group_msg' : 'send_private_msg', {
        [group ? 'group_id' : 'user_id']: match[2],
        message: [{ type: 'image', data: { file: `base64://${image.data}` } }],
      });
      if (sent?.message_id == null) throw new Error('OneBot 未返回图片消息 ID，无法确认送达');
      return sent.message_id;
    });
    this.sendQueue = task.catch(() => {});
    return task;
  }

  disconnect() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}

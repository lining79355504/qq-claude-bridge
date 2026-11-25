import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { OfficialApi } from './official-api.js';
import { imageBytes } from './images.js';
import { splitMarkdown } from './schedule-delivery.js';

const MESSAGE_INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

export class OfficialClient extends EventEmitter {
  constructor({ appId, appSecret, sendIntervalMs = 1100, messageMaxBytes = 3800,
    allowProactive = false, api = new OfficialApi({ appId, appSecret }),
    WebSocketImpl = WebSocket, reconnectMs = 1000, now = Date.now,
    replyWindowMs = 240000, maxReplies = 5 }) {
    super();
    Object.assign(this, { appId, api, sendIntervalMs, messageMaxBytes, allowProactive,
      WebSocketImpl, reconnectMs, now, replyWindowMs, maxReplies });
    this.stopped = true;
    this.ready = false;
    this.attempt = 0;
    this.sequence = null;
    this.sessionId = null;
    this.replies = new Map();
    this.sendQueue = Promise.resolve();
    this.lastSent = 0;
  }

  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    void this.open();
  }

  async open() {
    if (this.stopped) return;
    const signal = this.controller.signal;
    try {
      const url = await this.api.gateway(signal);
      const token = await this.api.accessToken(signal);
      if (signal.aborted) return;
      const socket = this.socket = new this.WebSocketImpl(url, { handshakeTimeout: 10000,
        maxPayload: 1024 * 1024, followRedirects: false });
      this.handshake = setTimeout(() => socket.terminate(), 15000);
      let acknowledged = true;
      const send = (packet) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
      };
      const heartbeat = () => {
        if (!acknowledged) return socket.terminate();
        acknowledged = false;
        send({ op: 1, d: this.sequence });
      };
      socket.on('error', () => this.emit('warning', 'QQ 官方 WebSocket 连接失败'));
      socket.on('message', (raw) => {
        if (this.stopped || socket !== this.socket) return;
        let packet;
        try { packet = JSON.parse(raw.toString()); } catch { return; }
        if (!packet || typeof packet !== 'object') return;
        if (Number.isSafeInteger(packet.s)) this.sequence = packet.s;
        if (packet.op === 10) {
          const interval = packet.d?.heartbeat_interval;
          if (!Number.isSafeInteger(interval) || interval < 1 || interval > 300000) return socket.terminate();
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(heartbeat, interval);
          send(this.sessionId ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence } }
            : { op: 2, d: { token: `QQBot ${token}`, intents: MESSAGE_INTENTS, shard: [0, 1] } });
        } else if (packet.op === 11) acknowledged = true;
        else if (packet.op === 1) send({ op: 1, d: this.sequence });
        else if (packet.op === 7) socket.terminate();
        else if (packet.op === 9) {
          if (!packet.d) { this.sessionId = null; this.sequence = null; }
          socket.terminate();
        } else if (packet.op === 0) {
          if (packet.t === 'READY' || packet.t === 'RESUMED') {
            if (packet.t === 'READY') {
              if (typeof packet.d?.session_id !== 'string' || !packet.d.session_id) return socket.terminate();
              this.sessionId = packet.d.session_id;
            }
            clearTimeout(this.handshake);
            this.ready = true;
            this.attempt = 0;
            this.emit('ready', this.appId);
          } else if (this.ready && ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(packet.t)) {
            this.emit('message', packet);
          }
        }
      });
      socket.on('close', (code) => {
        clearInterval(this.heartbeat);
        clearTimeout(this.handshake);
        this.ready = false;
        if ([4006, 4007, 4009].includes(code)) { this.sessionId = null; this.sequence = null; }
        if ([4004, 4013, 4014].includes(code)) {
          this.emit('warning', 'QQ 网关拒绝鉴权或事件权限，请核对应用凭据与 GROUP_AND_C2C_EVENT 权限后重启。');
          this.stopped = true;
          this.controller.abort();
        }
        this.emit('disconnected');
        this.reconnect();
      });
    } catch {
      if (signal.aborted) return;
      this.emit('warning', '无法连接 QQ 官方网关，请检查网络、AppID、AppSecret 和应用权限');
      this.reconnect();
    }
  }

  reconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(this.reconnectMs * 2 ** Math.min(this.attempt++, 5), 30000);
    this.reconnectTimer = setTimeout(() => void this.open(), delay);
  }

  rememberReply(frame) {
    this.targetOf(frame.target);
    if (!frame.reply || typeof frame.reply.id !== 'string' || !Number.isFinite(frame.reply.createdAt)) return;
    for (const [target, reply] of this.replies) {
      if (reply.createdAt + this.replyWindowMs <= this.now()) this.replies.delete(target);
    }
    const previous = this.replies.get(frame.target);
    if (previous && (previous.id === frame.reply.id || previous.createdAt > frame.reply.createdAt)) return;
    this.replies.delete(frame.target);
    while (this.replies.size >= 10000) this.replies.delete(this.replies.keys().next().value);
    this.replies.set(frame.target, { ...frame.reply, seq: 0 });
  }

  targetOf(target) {
    const match = /^qqbot:([1-9]\d*):(user|group):([\w-]+)$/.exec(target);
    if (!match || match[1] !== this.appId) throw new Error('QQ 官方消息目标不属于当前应用');
    return { type: match[2] === 'group' ? 'groups' : 'users', id: match[3] };
  }

  enqueueSend(operation) {
    const task = this.sendQueue.then(operation);
    this.sendQueue = task.catch(() => {});
    return task;
  }

  async waitToSend(signal) {
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) throw new Error('QQ 官方通道离线');
    const delay = this.sendIntervalMs - (this.now() - this.lastSent);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) throw new Error('QQ 官方通道离线');
  }

  replyFields(target, reserve = true) {
    const reply = this.replies.get(target);
    const passive = reply && reply.createdAt + this.replyWindowMs > this.now() && reply.seq < this.maxReplies;
    if (!passive && !this.allowProactive) {
      throw new Error('QQ 被动回复窗口或条数已用尽。请在原聊天发 /history 或 /status 获取结果；主动推送需要平台权限并开启 QQBOT_ALLOW_PROACTIVE。');
    }
    return passive ? { msg_id: reply.id, msg_seq: reserve ? ++reply.seq : reply.seq + 1 } : {};
  }

  sendMessage(target, content) {
    return this.enqueueSend(async () => {
      const { type, id } = this.targetOf(target);
      for (const chunk of splitMarkdown(content, this.messageMaxBytes)) {
        await this.waitToSend();
        const body = { content: chunk, msg_type: 0, ...this.replyFields(target) };
        this.lastSent = this.now();
        const result = await this.api.request(`/v2/${type}/${encodeURIComponent(id)}/messages`, { body, signal: this.controller.signal });
        if (!result?.id) throw new Error('QQ API 未返回消息 ID，无法确认送达');
      }
    });
  }

  sendImage(target, image, { signal } = {}) {
    return this.enqueueSend(async () => {
      imageBytes(image);
      const { type, id } = this.targetOf(target);
      await this.waitToSend(signal);
      // Avoid uploading when no reply can be sent. Recheck after the upload too.
      this.replyFields(target, false);
      const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
      const path = `/v2/${type}/${encodeURIComponent(id)}`;
      const uploaded = await this.api.request(`${path}/files`, { signal: combined,
        body: { file_type: 1, file_data: image.data, srv_send_msg: false } });
      if (typeof uploaded?.file_info !== 'string' || !uploaded.file_info) {
        throw new Error('QQ 图片上传未返回 file_info，未发送图片消息');
      }
      await this.waitToSend(signal);
      const body = { msg_type: 7, media: { file_info: uploaded.file_info }, ...this.replyFields(target) };
      this.lastSent = this.now();
      const sent = await this.api.request(`${path}/messages`, { body, signal: combined });
      if (!sent?.id) throw new Error('QQ API 未返回图片消息 ID，无法确认送达');
      return sent.id;
    });
  }

  disconnect() {
    this.stopped = true;
    this.ready = false;
    this.controller?.abort();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}

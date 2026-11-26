import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/onebot.js';
import { normalizeMessage, MessageDeduper } from '../src/qq-message.js';
import { imageFromBytes } from '../src/images.js';
import { QQProgress } from '../src/qq-progress.js';
import { config } from '../src/config.js';

const policy = { allowedUserIds: ['123'], allowedGroupIds: ['456'], groupRequireAt: true };
const event = (extra = {}) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend',
  user_id: 123, self_id: 789, message_id: 1, message: [{ type: 'text', data: { text: '/help' } }], ...extra });

test('QQ 白名单、群白名单、真实 @ 和私聊/群聊目标隔离', () => {
  assert.equal(normalizeMessage(event(), policy, '789').frame.target, 'user:123');
  assert.equal(normalizeMessage(event({ user_id: 124 }), policy, '789'), null);
  assert.equal(normalizeMessage(event({ user_id: 789 }), { ...policy, allowedUserIds: ['789'] }, '789'), null);
  assert.equal(normalizeMessage(event({ sub_type: 'group' }), policy, '789'), null);
  const group = event({ message_type: 'group', group_id: 456, message: '[CQ:at,qq=789] /new fix' });
  assert.equal(normalizeMessage(group, policy, '789').chatKey, 'group:456');
  assert.equal(normalizeMessage(group, policy, '789').text, '/new fix');
  assert.equal(normalizeMessage({ ...group, group_id: 457 }, policy, '789'), null);
  assert.equal(normalizeMessage({ ...group, message: '/help' }, policy, '789'), null);
  assert.equal(normalizeMessage({ ...group, message: '[CQ:at,qq=all] /help' }, policy, '789'), null);
  assert.equal(normalizeMessage({ ...group, message: '&#91;CQ:at,qq=789&#93; /help' }, policy, '789'), null);
  assert.equal(normalizeMessage({ ...group, message: '/help' }, { ...policy, groupRequireAt: false }, '789').text, '/help');
  assert.equal(normalizeMessage(event({ message: '[CQ:image,file=x]' }), policy, '789').imageSources.length, 1);
  assert.equal(normalizeMessage(event({ post_type: 'message_sent' }), policy, '789'), null);
  assert.equal(normalizeMessage(event({ message: [null, {}, { type: 'text' }] }), policy, '789'), null);
  assert.equal(normalizeMessage(event({ message: 'a&amp;b&#91;c&#93;' }), policy, '789').text, 'a&b[c]');
});

test('去重按聊天隔离、容量有界、过期后可重新接收；缺失消息 ID 不执行', () => {
  const deduper = new MessageDeduper({ ttlMs: 10, maxSize: 2 });
  assert.equal(deduper.accept(null, 0), false);
  assert.equal(deduper.accept('user:1:1', 0), true);
  assert.equal(deduper.accept('user:1:1', 1), false);
  assert.equal(deduper.accept('group:1:1', 1), true);
  assert.equal(deduper.accept('user:2:1', 2), true);
  assert.equal(deduper.seen.size, 2);
  assert.equal(deduper.accept('group:1:1', 20), true);
});

test('QQ 配置拒绝远程明文、URL 凭证和不明确工作目录', () => {
  for (const [key, invalid, getter] of [
    ['ONEBOT_WS_URL', ['http://localhost', 'ws://example.com', 'ws://user:pass@localhost', 'ws://localhost/?access_token=x'], 'onebotUrl'],
    ['CLAUDE_WORKSPACE', ['/', '~/repo', 'repo'], 'workspace'],
    ['QQ_MESSAGE_MAX_BYTES', ['1', '3801'], 'messageMaxBytes'],
    ['QQ_BOT_ID', ['abc', '1,2'], 'botQqId'],
    ['NAPCAT_WEBUI_URL', ['file:///tmp/a', 'http://example.com', 'http://localhost/?token=secret'], 'napcatWebuiUrl'],
  ]) {
    const original = process.env[key];
    try { for (const value of invalid) { process.env[key] = value; assert.throws(() => config[getter]); } }
    finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
  }
});

async function serverHarness(t, options = {}) {
  const realSocket = process.env.QQ_REAL_SOCKET_TESTS === '1';
  const server = realSocket ? new WebSocketServer({ port: 0, host: '127.0.0.1' }) : new EventEmitter();
  if (realSocket) await once(server, 'listening');
  else {
    server.clients = new Set();
    server.address = () => ({ port: 3001 });
    server.close = (callback) => callback();
  }
  class MemorySocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.readyState = 0;
      this.peer = new EventEmitter();
      this.peer.send = (data) => queueMicrotask(() => this.emit('message', Buffer.from(data)));
      this.peer.terminate = () => this.terminate();
      server.clients.add(this.peer);
      queueMicrotask(() => {
        server.emit('connection', this.peer, { headers: { authorization: options.headers.Authorization } });
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(data, callback) { queueMicrotask(() => { this.peer.emit('message', Buffer.from(data)); callback?.(); }); }
    ping() { queueMicrotask(() => this.emit('pong')); }
    terminate() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      server.clients.delete(this.peer);
      queueMicrotask(() => this.emit('close'));
    }
  }
  const requests = [];
  let connectionCount = 0;
  const warnings = [];
  server.on('connection', (socket, request) => {
    connectionCount++;
    assert.equal(request.headers.authorization, 'Bearer test-token');
    socket.on('message', (raw) => {
      const packet = JSON.parse(raw.toString());
      requests.push(packet);
      if (packet.action === 'get_login_info') {
        socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: { user_id: options.loginIds?.[Math.min(connectionCount - 1, options.loginIds.length - 1)] ?? 789 } }));
      } else if (packet.action === 'fail') {
        socket.send(JSON.stringify({ echo: packet.echo, status: 'failed', retcode: 100, wording: 'secret' }));
      } else if (packet.action.startsWith('upload_')) {
        socket.send(JSON.stringify({ echo: packet.echo, status: options.rejectUpload ? 'failed' : 'ok', retcode: options.rejectUpload ? 1404 : 0, data: null }));
      } else if (packet.action !== 'timeout') {
        const respond = () => socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: packet.action.startsWith('send_') ? { message_id: 99 } : packet.params }));
        if (packet.action === 'slow') setTimeout(respond, 15); else respond();
      }
    });
  });
  const client = new OneBotClient({ url: `ws://127.0.0.1:${server.address().port}`, token: 'test-token',
    sendIntervalMs: 1, reconnectMs: 5, requestTimeoutMs: 200, messageMaxBytes: 12, ...(realSocket ? {} : { WebSocketImpl: MemorySocket }), ...options });
  t.after(async () => {
    client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  client.on('warning', (message) => warnings.push(message));
  let readyCount = 0;
  client.on('ready', () => readyCount++);
  const ready = once(client, 'ready', { signal: AbortSignal.timeout(2000) });
  client.connect();
  await ready;
  return { client, server, requests, warnings, readyCount: () => readyCount, connections: () => connectionCount };
}

test('OneBot 协议模拟：鉴权、乱序 echo、错误回执、超时及纯文本分段', async (t) => {
  const { client, server, requests } = await serverHarness(t);
  const slow = client.call('slow', { value: 'slow' });
  const fast = client.call('fast', { value: 'fast' });
  assert.deepEqual(await fast, { value: 'fast' });
  assert.deepEqual(await slow, { value: 'slow' });
  await assert.rejects(client.call('fail'), /retcode=100/);
  await assert.rejects(client.call('timeout'), /超时/);
  assert.equal(client.pending.size, 0);
  const incoming = once(client, 'message');
  [...server.clients][0].send(JSON.stringify(event()));
  assert.equal((await incoming)[0].user_id, 123);
  await client.sendMessage('group:456', '中文😀[CQ:at,qq=all]');
  const sent = requests.filter((r) => r.action === 'send_group_msg');
  assert.ok(sent.length > 1);
  assert.equal(sent.map((r) => r.params.message[0].data.text).join(''), '中文😀[CQ:at,qq=all]');
  for (const r of sent) {
    assert.equal(r.params.group_id, '456');
    assert.equal(r.params.message[0].type, 'text');
    assert.ok(Buffer.byteLength(r.params.message[0].data.text) <= 12);
  }
  await client.sendMessage('user:123', 'hi');
  assert.equal(requests.at(-1).action, 'send_private_msg');
  await assert.rejects(client.sendMessage('456', 'bad'), /无效/);
});

test('OneBot 断线拒绝在途调用并重连；主动退出不再重连', async (t) => {
  const { client, server, connections } = await serverHarness(t);
  const pending = assert.rejects(client.call('timeout'), /断开/);
  const ready = once(client, 'ready');
  [...server.clients][0].terminate();
  await pending;
  await ready;
  assert.equal(connections(), 2);
  assert.equal(client.ready, true);
  const disconnected = once(client, 'disconnected');
  client.disconnect();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connections(), 2);
  await assert.rejects(client.sendMessage('user:123', 'offline'), /离线/);
});

test('QQ 进度节流、结果顺序，以及发送失败不改变已完成任务状态', async () => {
  const sent = [];
  let now = 0;
  const progress = new QQProgress({ send: async (text) => sent.push(text), ticketId: 1,
    intervalMs: 100, now: () => now, logger: { warn() {}, error() {} } });
  await progress.push('start');
  await progress.push('hidden');
  assert.equal(sent.length, 1);
  now = 100;
  const pending = progress.push('next');
  await progress.finish('result');
  await pending;
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1), 'result');
  await progress.push('too late');
  assert.equal(sent.length, 3);
  const failure = new QQProgress({ send: async () => { throw new Error('offline'); }, ticketId: 1,
    logger: { warn() {}, error() {} } });
  await failure.push('start');
  await failure.finish('saved result');
});


test('绑定的 QQ 账号不匹配时拒绝就绪，重连至正确账号后才能接收消息', async (t) => {
  const { client, warnings, connections, readyCount } = await serverHarness(t, {
    expectedSelfId: '789', loginIds: [111, 789],
  });
  assert.equal(connections(), 2);
  assert.equal(readyCount(), 1);
  assert.equal(client.selfId, '789');
  assert.ok(warnings.some((text) => text.includes('账号不匹配')));
});


test('OneBot 图片以 base64 image 段发送到私聊和群，取消后不发送', async (t) => {
  const h = await serverHarness(t);
  const image = imageFromBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  for (const target of ['user:123', 'group:456']) {
    assert.equal(await h.client.sendImage(target, image), 99);
    assert.equal(h.requests.at(-1).action, target.startsWith('user') ? 'send_private_msg' : 'send_group_msg');
    assert.deepEqual(h.requests.at(-1).params.message, [{ type: 'image', data: { file: `base64://${image.data}` } }]);
  }
  const count = h.requests.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.client.sendImage('user:123', image, { signal: controller.signal }));
  assert.equal(h.requests.length, count);
});


test('OneBot 普通文件使用上传扩展，中文名和字节保留；data:null 仅表示服务已接受', async (t) => {
  const h = await serverHarness(t);
  const file = { name: '测试文件.pdf', data: Buffer.from('%PDF-test').toString('base64') };
  for (const target of ['user:123', 'group:456']) {
    assert.deepEqual(await h.client.sendFile(target, file), { status: 'accepted' });
    const request = h.requests.at(-1);
    assert.equal(request.action, target.startsWith('user') ? 'upload_private_file' : 'upload_group_file');
    assert.equal(request.params.name, file.name);
    assert.equal(request.params.file, `base64://${file.data}`);
  }
  const count = h.requests.length;
  await assert.rejects(h.client.sendFile('user:123', file, { signal: AbortSignal.abort() }));
  assert.equal(h.requests.length, count);
  const rejected = await serverHarness(t, { rejectUpload: true });
  await assert.rejects(rejected.client.sendFile('group:456', file), /retcode=1404/);
  assert.equal(rejected.requests.filter((r) => r.action.startsWith('upload_')).length, 1);
});

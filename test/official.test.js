import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';
import { connectByQr, selectCredentials, saveOfficialBinding } from '../src/official-login.js';
import { normalizeOfficialMessage } from '../src/official-message.js';
import { OfficialApi } from '../src/official-api.js';
import { OfficialClient } from '../src/official-client.js';
import { config, validateConfig } from '../src/config.js';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { imageFromBytes } from '../src/images.js';
import { QQProgress } from '../src/qq-progress.js';

const policy = { appId: '12345', allowedUserIds: ['USER_A'], allowedGroupIds: ['GROUP_A'] };
const event = (extra = {}) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: {
  id: 'message-1', content: '/new 检查代码', timestamp: new Date(100000).toISOString(), author: { user_openid: 'USER_A' }, ...extra,
} });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

function mockFetch() {
  const calls = [];
  let tokenCount = 0;
  const fn = async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    if (url === 'https://bots.qq.com/app/getAppAccessToken') return response({ access_token: `token-${++tokenCount}`, expires_in: '7200' });
    if (url === 'https://api.sgroup.qq.com/gateway') return response({ url: 'wss://api.sgroup.qq.com/websocket' });
    if (url.endsWith('/files')) return response({ file_info: 'uploaded-image-info' });
    if (/\/v2\/(users|groups)\//.test(url)) return response({ id: `sent-${calls.length}` });
    throw new Error('Unexpected endpoint');
  };
  return { calls, fn };
}

async function clientHarness(t, extra = {}) {
  const http = mockFetch();
  const sockets = [], frames = [];
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.readyState = 1;
      sockets.push(this);
      assert.equal(url, 'wss://api.sgroup.qq.com/websocket');
      queueMicrotask(() => this.receive({ op: 10, d: { heartbeat_interval: extra.heartbeatMs ?? 10000 } }));
    }
    receive(packet) { this.emit('message', Buffer.from(JSON.stringify(packet))); }
    send(raw) {
      const packet = JSON.parse(raw);
      frames.push(packet);
      if (packet.op === 2) queueMicrotask(() => this.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }));
      if (packet.op === 6) queueMicrotask(() => this.receive({ op: 0, t: 'RESUMED', s: packet.d.seq + 1, d: {} }));
      if (packet.op === 1 && extra.acknowledge !== false) queueMicrotask(() => this.receive({ op: 11 }));
    }
    terminate(code = 1006) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', code));
    }
  }
  let now = 100000;
  const api = new OfficialApi({ appId: policy.appId, appSecret: 'secret', fetchImpl: http.fn, now: () => now });
  const client = new OfficialClient({ appId: policy.appId, api, WebSocketImpl: FakeSocket,
    now: () => now, sendIntervalMs: 0, reconnectMs: 1, ...extra });
  t.after(() => client.disconnect());
  const ready = once(client, 'ready', { signal: AbortSignal.timeout(2000) });
  client.connect();
  await ready;
  return { client, api, sockets, frames, http, advance(ms) { now += ms; } };
}

test('SDK 回调扫码：开启终端二维码、返回数组并选择应用、取消/超时后忽略迟到的成功', async () => {
  let callbacks, opts, stopped = 0;
  const start = (c, o) => { callbacks = c; opts = o; return () => stopped++; };
  const pending = connectByQr(start);
  assert.equal(opts.displayQrCodeToConsole, true);
  callbacks.onSuccess([{ appId: '12345', appSecret: 'secret', userOpenid: 'USER_A' }]);
  assert.deepEqual(await pending, { appId: '12345', appSecret: 'secret', userOpenid: 'USER_A' });
  assert.equal(stopped, 1);
  const controller = new AbortController();
  const cancelled = connectByQr(start, { signal: controller.signal });
  controller.abort();
  callbacks.onSuccess([{ appId: '12345', appSecret: 'secret' }]);
  await assert.rejects(cancelled, /取消/);
  await assert.rejects(connectByQr(start, { timeoutMs: 5 }), /超时/);
  assert.throws(() => selectCredentials([{ appId: '1', appSecret: 'a' }, { appId: '2', appSecret: 'b' }]), /多个/);
  assert.equal(selectCredentials([{ appId: '1', appSecret: 'a' }, { appId: '2', appSecret: 'b' }], '2').appId, '2');
  assert.throws(() => selectCredentials([{ appId: '123', appSecret: 'bad\nvalue' }]), /无效/);
});

test('官方凭据写入：可首次创建 .env，不改变 workspace；换应用清空旧 OpenID 权限；无 userOpenid 拒绝所有人', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-bind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  await saveOfficialBinding(file, { appId: '12345', appSecret: 'has#hash', userOpenid: 'USER_A' });
  assert.deepEqual(parse(await readFile(file, 'utf8')), {
    QQ_TRANSPORT: 'official', QQBOT_APP_ID: '12345', QQBOT_APP_SECRET: 'has#hash',
    QQBOT_ALLOWED_USER_IDS: 'USER_A', QQBOT_ALLOWED_GROUP_IDS: '',
  });
  await writeFile(file, (await readFile(file, 'utf8')) + 'CLAUDE_WORKSPACE=/repo\n');
  await saveOfficialBinding(file, { appId: '12345', appSecret: 'new-secret', userOpenid: 'USER_B' });
  assert.equal(parse(await readFile(file, 'utf8')).QQBOT_ALLOWED_USER_IDS, 'USER_A');
  const changed = await saveOfficialBinding(file, { appId: '54321', appSecret: 'new-app-secret' });
  assert.equal(changed.needsAllowlist, true);
  const result = parse(await readFile(file, 'utf8'));
  assert.equal(result.QQBOT_ALLOWED_USER_IDS, 'bootstrap-deny-all');
  assert.equal(result.CLAUDE_WORKSPACE, '/repo');
  assert.equal(result.QQBOT_APP_ID, '54321');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('官方消息按应用隔离，OpenID 双白名单及群 @事件；旧时间不延长被动回复窗口', () => {
  const message = normalizeOfficialMessage(event(), policy, { now: 200000 });
  assert.equal(message.chatKey, 'qqbot:12345:user:USER_A');
  assert.equal(message.frame.reply.createdAt, 100000);
  assert.equal(message.userId, 'USER_A');
  assert.ok(normalizeOfficialMessage(event({ id: 'ROBOT1.0_opaque.id' }), policy));
  const groupEvent = { ...event({ group_openid: 'GROUP_A', author: { member_openid: 'USER_A' }, content: '<@!BOT> /status' }), t: 'GROUP_AT_MESSAGE_CREATE' };
  assert.equal(normalizeOfficialMessage(groupEvent, policy).text, '/status');
  assert.equal(normalizeOfficialMessage(groupEvent, policy).frame.target, 'qqbot:12345:group:GROUP_A');
  assert.equal(normalizeOfficialMessage(groupEvent, { ...policy, allowedGroupIds: [] }), null);
  let denied;
  assert.equal(normalizeOfficialMessage(event({ author: { user_openid: 'OTHER' } }), policy, { onDenied: (value) => { denied = value; } }), null);
  assert.equal(denied.userId, 'OTHER');
  assert.equal(normalizeOfficialMessage({ ...event(), t: 'MESSAGE_CREATE' }, policy), null);
  assert.equal(normalizeOfficialMessage(event({ id: '' }), policy), null);
  assert.equal(normalizeOfficialMessage(event({ content: '', attachments: [{}] }), policy), null);
});

test('官方与 OneBot 独立配置及数据库，官方不需要 OneBot token', () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { QQ_TRANSPORT: 'official', QQBOT_APP_ID: '12345', QQBOT_APP_SECRET: 'test-secret',
      QQBOT_ALLOWED_USER_IDS: 'USER_A', QQBOT_ALLOWED_GROUP_IDS: 'GROUP_A', CLAUDE_WORKSPACE: process.cwd() });
    delete process.env.TICKET_DB_PATH;
    delete process.env.ONEBOT_ACCESS_TOKEN;
    validateConfig();
    assert.deepEqual(config.allowedUserIds, ['USER_A']);
    assert.ok(config.ticketDbPath.endsWith('qqbot-12345.sqlite'));
    process.env.QQ_TRANSPORT = 'onebot';
    process.env.QQ_ALLOWED_USER_IDS = '123';
    assert.deepEqual(config.allowedUserIds, ['123']);
    assert.ok(config.ticketDbPath.endsWith('tickets.sqlite'));
    assert.throws(validateConfig, /ONEBOT_ACCESS_TOKEN/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('Token 单次刷新并缓存、提前过期刷新；正确 Authorization、AppID 和消息 JSON', async () => {
  const http = mockFetch();
  let now = 0;
  const api = new OfficialApi({ appId: '12345', appSecret: 'secret', fetchImpl: http.fn, now: () => now });
  assert.deepEqual(await Promise.all([api.accessToken(), api.accessToken()]), ['token-1', 'token-1']);
  assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].body, { appId: '12345', clientSecret: 'secret' });
  await api.request('/v2/users/USER_A/messages', { body: { content: 'hi', msg_type: 0, msg_id: 'm', msg_seq: 1 } });
  const request = http.calls.at(-1);
  assert.equal(request.options.headers.Authorization, 'QQBot token-1');
  assert.equal(request.options.headers['X-Union-Appid'], '12345');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.msg_seq, 1);
  now = 7200000;
  assert.equal(await api.accessToken(), 'token-2');
});

test('API 失败不泄露密钥；401 清缓存但不自动重发消息；429/网络超时不盲目重试', async () => {
  for (const status of [401, 429, 500]) {
    let messageCalls = 0;
    const api = new OfficialApi({ appId: '1', appSecret: 'secret', fetchImpl: async (url) => {
      if (url.includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
      messageCalls++;
      return response({ code: 123, message: 'secret token private text' }, status);
    } });
    await assert.rejects(api.request('/v2/users/u/messages', { body: { content: 'private text' } }), (e) => {
      assert.ok(!e.message.includes('secret'));
      assert.ok(e.message.includes(String(status)));
      return true;
    });
    assert.equal(messageCalls, 1);
    if (status === 401) assert.equal(api.token, null);
  }
  const network = new OfficialApi({ appId: '1', appSecret: 'secret', fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(network.accessToken(), (error) => !error.message.includes('secret'));
});

test('网关 Identify、事件、心跳、断线 Resume 与 Invalid Session 重新 Identify', async (t) => {
  const h = await clientHarness(t, { heartbeatMs: 5 });
  assert.deepEqual(h.frames[0], { op: 2, d: { token: 'QQBot token-1', intents: 1 << 25, shard: [0, 1] } });
  const message = once(h.client, 'message');
  h.sockets[0].receive(event());
  assert.equal((await message)[0].d.id, 'message-1');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(h.frames.some((p) => p.op === 1 && p.d === 3));
  let ready = once(h.client, 'ready', { signal: AbortSignal.timeout(2000) });
  h.sockets[0].terminate();
  await ready;
  assert.ok(h.frames.some((p) => p.op === 6 && p.d.seq === 3 && p.d.session_id === 'session-1'));
  ready = once(h.client, 'ready', { signal: AbortSignal.timeout(2000) });
  h.sockets.at(-1).receive({ op: 9, d: false });
  await ready;
  assert.equal(h.frames.filter((p) => p.op === 2).length, 2);
});

test('丢失心跳 ACK 后重连，权限关闭码停止重试', async (t) => {
  const h = await clientHarness(t, { heartbeatMs: 5, acknowledge: false });
  const ready = once(h.client, 'ready', { signal: AbortSignal.timeout(2000) });
  await ready;
  assert.ok(h.sockets.length >= 2);
  const disconnected = once(h.client, 'disconnected');
  h.sockets.at(-1).terminate(4014);
  await disconnected;
  assert.equal(h.client.stopped, true);
  assert.equal(h.client.ready, false);
});

test('回复使用 msg_id 与递增 msg_seq；分段；跨应用拒绝；过期/耗尽不冒充主动消息', async (t) => {
  const h = await clientHarness(t, { messageMaxBytes: 8, maxReplies: 2 });
  const frame = normalizeOfficialMessage(event(), policy, { now: 100000 }).frame;
  h.client.rememberReply(frame);
  await h.client.sendMessage(frame.target, '你好😀');
  const sends = h.http.calls.filter((c) => c.url.includes('/messages'));
  assert.equal(sends.length, 2);
  assert.equal(sends.map((r) => r.body.content).join(''), '你好😀');
  assert.deepEqual(sends.map((r) => [r.body.msg_id, r.body.msg_seq]), [['message-1', 1], ['message-1', 2]]);
  h.client.rememberReply(frame);
  await assert.rejects(h.client.sendMessage(frame.target, 'more'), /条数/);
  await assert.rejects(h.client.sendMessage('qqbot:54321:user:USER_A', 'bad'), /不属于/);
  h.client.rememberReply({ target: frame.target, reply: { id: 'message-2', createdAt: 100000 } });
  h.advance(240001);
  await assert.rejects(h.client.sendMessage(frame.target, 'late'), /窗口/);
  h.client.allowProactive = true;
  await h.client.sendMessage(frame.target, 'proactive');
  assert.equal(h.http.calls.at(-1).body.msg_id, undefined);
});

test('官方消息 → 工单 → 模拟 Claude → 官方回复；结果持久化且账号隔离', async (t) => {
  const h = await clientHarness(t);
  const store = new TicketStore(':memory:');
  t.after(() => store.close());
  const send = (frame, text) => h.client.sendMessage(frame.target, text);
  const bot = new TicketBot({ store, config: { ...policy, workspace: process.cwd(), allowedPaths: [process.cwd()],
    permissionMode: 'auto', approvalTimeoutMs: 100, sessionTtlMs: 100, readOnlyTools: [] },
    logger: { error() {}, warn() {} }, send,
    createProgress: (frame, ticket) => {
      const progress = new QQProgress({ ticketId: ticket.id, send: (text) => send(frame, text), logger: { warn() {}, error() {} } });
      return { push: async () => {}, finish: (text) => progress.finish(text) };
    },
    createSession: () => ({ isBusy: () => false, abort() {}, run: async () => '检查完成', lastRunSucceeded: true }),
  });
  const message = normalizeOfficialMessage(event(), policy, { now: 100000 });
  h.client.rememberReply(message.frame);
  await bot.handle(message);
  await bot.drainPromise;
  await flush();
  assert.equal(store.get(1).status, 'review');
  assert.ok(store.history(1).some((m) => m.content === '检查完成'));
  assert.equal(store.list('qqbot:54321:user:USER_A').length, 0);
  const sends = h.http.calls.filter((c) => c.url.includes('/messages'));
  assert.equal(sends.length, 2);
  assert.ok(sends.at(-1).body.content.includes('检查完成'));
});

test('过期或条数耗尽后结果仍可用新消息分页取回，模型只执行一次', async (t) => {
  for (const reason of ['expired', 'exhausted']) {
    const h = await clientHarness(t, { maxReplies: reason === 'exhausted' ? 1 : 5 });
    const store = new TicketStore(':memory:');
    t.after(() => store.close());
    const logs = [];
    let runs = 0;
    const answer = '完整测试结果🧪\n'.repeat(500);
    const logger = { warn() {}, error: (...args) => logs.push(args.join(' ')) };
    const send = (frame, text) => h.client.sendMessage(frame.target, text);
    const bot = new TicketBot({ store, config: { ...policy, transport: 'official', messageMaxBytes: 3800,
      workspace: process.cwd(), allowedPaths: [process.cwd()], permissionMode: 'auto', readOnlyTools: [] },
    logger, send,
    createProgress: (frame, ticket) => new QQProgress({ ticketId: ticket.id, send: (text) => send(frame, text), logger }),
    createSession: () => ({ isBusy: () => false, abort() {}, lastRunSucceeded: true, run: async () => {
      runs++;
      if (reason === 'expired') h.advance(240001);
      return answer;
    } }),
    });
    const message = normalizeOfficialMessage(event(), policy, { now: 100000 });
    h.client.rememberReply(message.frame);
    await bot.handle(message);
    await bot.drainPromise;
    assert.equal(store.get(1).status, 'review');
    assert.equal(store.result(1).content, answer);
    assert.ok(logs.some((text) => text.includes('/result 1')));
    assert.equal(h.http.calls.filter((call) => call.url.includes('/messages')).length, 1);
    let command = '/result 1';
    let page = 0;
    while (command) {
      const time = reason === 'expired' ? 340001 : 100000;
      const query = normalizeOfficialMessage(event({ id: `result-${++page}`, content: command,
        timestamp: new Date(time).toISOString() }), policy, { now: time });
      h.client.rememberReply(query.frame);
      const before = h.http.calls.length;
      await bot.handle(query);
      assert.equal(h.http.calls.length, before + 1);
      const body = h.http.calls.at(-1).body;
      assert.equal(body.msg_id, `result-${page}`);
      assert.equal(body.msg_seq, 1);
      assert.ok(Buffer.byteLength(body.content) <= 3800);
      command = /下一页：(.*)$/.exec(body.content)?.[1];
      assert.ok(page < 20);
    }
    assert.ok(page > 1);
    assert.equal(runs, 1);
    assert.equal(h.client.allowProactive, false);
  }
});


test('官方图片上传后发送富媒体消息，私聊/群聊共用文本回复序号与队列', async (t) => {
  const h = await clientHarness(t);
  const image = imageFromBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  for (const kind of ['user', 'group']) {
    const target = `qqbot:12345:${kind}:DEST`;
    h.client.rememberReply({ target, reply: { id: `incoming-${kind}`, createdAt: 100000 } });
    await h.client.sendMessage(target, '正在处理');
    const id = await h.client.sendImage(target, image);
    assert.ok(id.startsWith('sent-'));
    const [upload, sent] = h.http.calls.slice(-2);
    assert.equal(upload.url, `https://api.sgroup.qq.com/v2/${kind === 'user' ? 'users' : 'groups'}/DEST/files`);
    assert.deepEqual(upload.body, { file_type: 1, file_data: image.data, srv_send_msg: false });
    assert.deepEqual(sent.body, { msg_type: 7, media: { file_info: 'uploaded-image-info' }, msg_id: `incoming-${kind}`, msg_seq: 2 });
  }
});

test('图片回复过期不上传；上传失败、缺回执、取消均失败且不重放发送', async (t) => {
  const h = await clientHarness(t);
  const image = imageFromBytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  const target = 'qqbot:12345:user:DEST';
  const calls = [];
  h.api.request = async (path) => { calls.push(path); return {}; };
  await assert.rejects(h.client.sendImage(target, image), /窗口/);
  assert.equal(calls.length, 0);
  h.client.rememberReply({ target, reply: { id: 'incoming', createdAt: 100000 } });
  await assert.rejects(h.client.sendImage(target, image), /file_info/);
  assert.equal(calls.length, 1);
  h.api.request = async (path) => { calls.push(path); return path.endsWith('/files') ? { file_info: 'file-info' } : {}; };
  await assert.rejects(h.client.sendImage(target, image), /无法确认送达/);
  assert.equal(calls.length, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.client.sendImage(target, image, { signal: controller.signal }));
  assert.equal(calls.length, 3);
  const midUpload = new AbortController();
  h.api.request = async (path) => { calls.push(path); midUpload.abort(); return { file_info: 'file-info' }; };
  await assert.rejects(h.client.sendImage(target, image, { signal: midUpload.signal }));
  assert.equal(calls.length, 4);
});


test('官方普通文件尝试 type=4，保留文件名，两阶段回执成功后才确认发送', async (t) => {
  const h = await clientHarness(t);
  const file = { name: '报告.pdf', data: Buffer.from('%PDF-test').toString('base64') };
  for (const type of ['user', 'group']) {
    const target = `qqbot:12345:${type}:DEST`;
    h.client.rememberReply({ target, reply: { id: `incoming-${type}`, createdAt: 100000 } });
    await h.client.sendMessage(target, '准备发送');
    assert.equal((await h.client.sendFile(target, file)).status, 'sent');
    const [upload, send] = h.http.calls.slice(-2);
    assert.equal(upload.url, `https://api.sgroup.qq.com/v2/${type === 'user' ? 'users' : 'groups'}/DEST/files`);
    assert.deepEqual(upload.body, { file_type: 4, file_name: '报告.pdf', file_data: file.data, srv_send_msg: false });
    assert.deepEqual(send.body, { msg_type: 7, media: { file_info: 'uploaded-image-info' }, msg_id: `incoming-${type}`, msg_seq: 2 });
  }
});

test('官方普通文件被平台拒绝时不发送消息、不重试、不绕过；窗口过期/取消不上传', async (t) => {
  const h = await clientHarness(t);
  const target = 'qqbot:12345:user:DEST';
  const file = { name: 'a.zip', data: Buffer.from('ZIP').toString('base64') };
  const calls = [];
  h.api.request = async (path) => { calls.push(path); throw new Error('QQ API HTTP 400，code=123'); };
  await assert.rejects(h.client.sendFile(target, file), /窗口/);
  assert.equal(calls.length, 0);
  h.client.rememberReply({ target, reply: { id: 'm1', createdAt: 100000 } });
  await assert.rejects(h.client.sendFile(target, file), /可能不支持通用文件/);
  assert.deepEqual(calls, ['/v2/users/DEST/files']);
  await assert.rejects(h.client.sendFile(target, file, { signal: AbortSignal.abort() }));
  assert.equal(calls.length, 1);
  h.api.request = async () => ({});
  await assert.rejects(h.client.sendFile(target, file), /file_info/);
  h.api.request = async (path) => path.endsWith('/files') ? { file_info: 'file-info' } : {};
  await assert.rejects(h.client.sendFile(target, file), /无法确认送达/);
});

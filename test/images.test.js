import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { imageFromBytes, imageBytes, imageUrl, downloadImage, prepareImages, MAX_IMAGE_BYTES,
  readWorkspaceImage } from '../src/images.js';
import { normalizeOfficialMessage } from '../src/official-message.js';
import { normalizeMessage } from '../src/qq-message.js';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { ClaudeSession } from '../src/claude.js';
import { imageTool, imageServer, IMAGE_TOOL_NAME } from '../src/image-tool.js';
import { createToolGuard } from '../src/guard.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const picture = imageFromBytes(png);
const officialPolicy = { appId: '12345', allowedUserIds: ['USER_A'], allowedGroupIds: ['GROUP_A'] };
const logger = { info() {}, warn() {}, error() {} };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('官方和 OneBot：纯图片、图片说明、群 @与白名单，非图片不触发 Claude', () => {
  const event = { t: 'C2C_MESSAGE_CREATE', d: { id: 'img.1', author: { user_openid: 'USER_A' },
    attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/a', size: png.length }] } };
  const message = normalizeOfficialMessage(event, officialPolicy);
  assert.equal(message.text, '请分析这些图片。');
  assert.equal(message.imageSources.length, 1);
  assert.equal(normalizeOfficialMessage({ ...event, d: { ...event.d, content: '解释报错' } }, officialPolicy).text, '解释报错');
  assert.equal(normalizeOfficialMessage(event, { ...officialPolicy, allowedUserIds: [] }), null);
  assert.equal(normalizeOfficialMessage({ ...event, d: { ...event.d, attachments: [{ content_type: 'application/pdf' }] } }, officialPolicy), null);
  const group = { t: 'GROUP_AT_MESSAGE_CREATE', d: { ...event.d, group_openid: 'GROUP_A', author: { member_openid: 'USER_A' } } };
  assert.ok(normalizeOfficialMessage(group, officialPolicy));
  assert.equal(normalizeOfficialMessage(group, { ...officialPolicy, allowedGroupIds: [] }), null);
  const onebot = { post_type: 'message', message_type: 'group', user_id: 123, group_id: 456,
    message_id: 1, message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] };
  const policy = { allowedUserIds: ['123'], allowedGroupIds: ['456'], groupRequireAt: true };
  assert.equal(normalizeMessage(onebot, policy, '789'), null);
  onebot.message.push({ type: 'at', data: { qq: '789' } });
  assert.equal(normalizeMessage(onebot, policy, '789').imageSources[0].url, 'https://gchat.qpic.cn/a');
});

test('下载图片：限制 QQ CDN、跳转逐次检查，不带 token；验证文件内容和实际大小', async () => {
  for (const url of ['https://127.0.0.1/a', 'file:///etc/passwd', 'https://qpic.cn.evil.test/a',
    'https://user:pass@gchat.qpic.cn/a', 'https://gchat.qpic.cn:123/a', undefined]) {
    assert.throws(() => imageUrl(url), /地址|只允许/);
  }
  assert.equal(imageUrl('//gchat.qpic.cn/a'), 'https://gchat.qpic.cn/a');
  assert.equal(imageUrl('http://multimedia.nt.qq.com.cn/a'), 'https://multimedia.nt.qq.com.cn/a');
  const image = await downloadImage({ url: 'https://gchat.qpic.cn/a' }, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    return new Response(png);
  } });
  assert.deepEqual(imageBytes(image), png);
  await assert.rejects(downloadImage({ url: 'https://gchat.qpic.cn/a' }, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
  }), /只允许/);
  await assert.rejects(downloadImage({ url: 'https://gchat.qpic.cn/a' }, {
    fetchImpl: async () => new Response('not-an-image', { headers: { 'content-type': 'image/png' } }),
  }), /文件内容/);
  await assert.rejects(downloadImage({ url: 'https://gchat.qpic.cn/a' }, {
    fetchImpl: async () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
  }), /超过/);
  await assert.rejects(downloadImage({ url: 'https://gchat.qpic.cn/a?secret=value' }, {
    fetchImpl: async () => { throw new Error('https://gchat.qpic.cn/a?secret=value'); },
  }), (error) => !error.message.includes('secret'));
  await assert.rejects(prepareImages(Array(5).fill({})), /最多 4/);
  assert.throws(() => imageBytes({ ...picture, mediaType: 'image/jpeg' }), /校验失败/);
});

test('发送文件：工作目录内真实图片可发送，越界/符号链接/目录/伪装文件拒绝', async (t) => {
  const dir = await directory(t);
  const outside = await directory(t);
  await writeFile(join(dir, 'image.png'), png);
  await writeFile(join(outside, 'private.png'), png);
  await symlink(join(outside, 'private.png'), join(dir, 'escape.png'));
  await writeFile(join(dir, 'fake.png'), 'private credentials');
  assert.deepEqual(await readWorkspaceImage('image.png', dir, [dir]), picture);
  await assert.rejects(readWorkspaceImage(join(outside, 'private.png'), dir, '*'), /范围/);
  await assert.rejects(readWorkspaceImage('escape.png', dir, [dir]), /范围/);
  await assert.rejects(readWorkspaceImage('.', dir, [dir]), /普通文件/);
  await assert.rejects(readWorkspaceImage('fake.png', dir, [dir]), /文件内容/);
});

test('图片 MCP 工具只发送到注入的当前聊天，停止/禁用/失败不报告成功；工具围栏生效', async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, 'image.png'), png);
  const controller = new AbortController();
  const sent = [];
  const opts = { workspace: dir, getAllowedPaths: () => [dir], getDeniedTools: () => [],
    getSignal: () => controller.signal, onImage: async (image) => sent.push(image) };
  const definition = imageTool(opts);
  const result = await definition.handler({ file_path: 'image.png' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(sent, [picture]);
  assert.equal((await imageTool({ ...opts, getDeniedTools: () => [IMAGE_TOOL_NAME] }).handler({ file_path: 'image.png' })).isError, true);
  const failed = await imageTool({ ...opts, onImage: async () => { throw new Error('QQ 回复额度已用尽'); } }).handler({ file_path: 'image.png' });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /未能确认发送/);
  controller.abort();
  assert.equal((await definition.handler({ file_path: 'image.png' })).isError, true);
  assert.equal(sent.length, 1);
  const guard = createToolGuard({ workspace: dir, allowedPaths: [dir], deniedTools: [] });
  assert.equal((await guard({ tool_name: IMAGE_TOOL_NAME, tool_input: { file_path: '/outside/image.png' } })).hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude SDK 收到文字和真实 base64 图片块；续会话及发送工具可用', async () => {
  let received, options;
  const session = new ClaudeSession({ workspace: process.cwd(), chatKey: 'chat', logger, sessionId: 'old-session',
    onImage: async () => {}, queryFn: async function* (args) {
      options = args.options;
      for await (const input of args.prompt) received = input;
      yield { type: 'result', subtype: 'success', result: '图里是一张截图' };
    } });
  assert.equal(await session.run('分析图片', { images: [picture] }), '图里是一张截图');
  assert.equal(received.type, 'user');
  assert.match(received.message.content[0].text, /本轮桥接能力说明/);
  assert.match(received.message.content[0].text, /历史对话.*已过时/);
  assert.ok(received.message.content[0].text.endsWith('分析图片'));
  assert.deepEqual(received.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: picture.data } });
  assert.equal(options.resume, 'old-session');
  assert.ok(options.mcpServers.qq.instance);
  assert.ok(!options.allowedTools?.includes(IMAGE_TOOL_NAME));
  assert.match(options.systemPrompt.append, /send_image/);
  await options.mcpServers.qq.instance.close();
});

function botHarness(store, run) {
  const sent = [], imageTargets = [];
  const bot = new TicketBot({ store, logger, config: { workspace: process.cwd(), allowedPaths: [process.cwd()],
    permissionMode: 'auto', readOnlyTools: [], approvalTimeoutMs: 1000 },
    send: async (_frame, text) => sent.push(text),
    sendImage: async (frame) => imageTargets.push(frame.target),
    createProgress: () => ({ push: async () => {}, finish: async () => {} }),
    createSession: (args) => ({ ...args, isBusy: () => false, abort() {},
      run: async (prompt, options) => run(prompt, options, args) }),
  });
  return { bot, sent, imageTargets };
}

test('图片随需求排队、/new 附图、纯图片不丢失；历史不输出 base64；发图目标固定为原工单', async (t) => {
  const store = new TicketStore(':memory:');
  t.after(() => store.close());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const h = botHarness(store, async (_prompt, options, session) => {
    calls.push(options.images);
    if (calls.length === 1) await gate;
    await session.onImage(picture);
    return '完成';
  });
  await h.bot.handle({ chatKey: 'chat:1', userId: 'a', text: '/new 分析图片', images: [picture], frame: { target: 'chat:1' } });
  await flush();
  await h.bot.handle({ chatKey: 'chat:2', userId: 'b', text: '另一张图', images: [picture], frame: { target: 'chat:2' } });
  assert.equal(calls.length, 1);
  release();
  await h.bot.drainPromise;
  assert.deepEqual(calls, [[picture], [picture]]);
  assert.deepEqual(h.imageTargets, ['chat:1', 'chat:2']);
  await h.bot.handle({ chatKey: 'chat:1', userId: 'a', text: '/history', frame: { target: 'chat:1' } });
  assert.match(h.sent.at(-1), /附 1 张图片/);
  assert.ok(!h.sent.at(-1).includes(picture.data));
});

test('旧数据库迁移保留文本，图片重启后 /resume 使用持久化内容，无需重新下载 URL', async (t) => {
  const dir = await directory(t);
  const file = join(dir, 'tickets.sqlite');
  // Simulate a pre-image-schema database.
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)');
  old.close();
  let store = new TicketStore(file);
  const ticket = store.create('chat:1', 'a', '图片', process.cwd());
  store.enqueue(ticket.id, '分析', [picture]);
  store.close();
  store = new TicketStore(file);
  t.after(() => store.close());
  let actual;
  const h = botHarness(store, async (_prompt, options) => { actual = options.images; return '恢复完成'; });
  assert.equal(store.get(ticket.id).status, 'stopped');
  await h.bot.handle({ chatKey: 'chat:1', userId: 'a', text: '/resume', frame: { target: 'chat:1' } });
  await h.bot.drainPromise;
  assert.deepEqual(actual, [picture]);
  assert.equal(store.get(ticket.id).status, 'review');
});

test('发图不通过 allowedTools 绕过回调：有效图片放行，禁用/越界/取消/旧轮次拒绝，其他工具继续原审批', async (t) => {
  const dir = await directory(t);
  const outside = await directory(t);
  await writeFile(join(dir, 'image.png'), png);
  await writeFile(join(outside, 'image.png'), png);
  await symlink(join(outside, 'image.png'), join(dir, 'escape.png'));
  const previousPaths = process.env.CLAUDE_ALLOWED_PATHS;
  const previousDenied = process.env.DENIED_TOOLS;
  let oldCallback;
  let calls = 0;
  const fallback = [];
  const session = new ClaudeSession({ workspace: dir, chatKey: 'chat', logger, onImage: async () => {},
    canUseTool: async (name, input, opts) => {
      fallback.push({ name, input, opts });
      return { behavior: 'deny', message: '沿用原工具权限规则' };
    },
    queryFn: async function* ({ options }) {
      assert.equal(options.allowedTools, undefined);
      if (++calls === 2) {
        assert.equal((await oldCallback(IMAGE_TOOL_NAME, { file_path: 'image.png' }, {})).behavior, 'deny');
      }
      const permit = options.canUseTool;
      assert.equal((await permit(IMAGE_TOOL_NAME, { file_path: 'image.png' }, {})).behavior, 'allow');
      for (const file_path of ['escape.png', join(outside, 'image.png'), 'missing.png']) {
        assert.equal((await permit(IMAGE_TOOL_NAME, { file_path }, {})).behavior, 'deny');
      }
      process.env.DENIED_TOOLS = IMAGE_TOOL_NAME;
      assert.equal((await permit(IMAGE_TOOL_NAME, { file_path: 'image.png' }, {})).behavior, 'deny');
      process.env.DENIED_TOOLS = '';
      const aborted = AbortSignal.abort();
      assert.equal((await permit(IMAGE_TOOL_NAME, { file_path: 'image.png' }, { signal: aborted })).behavior, 'deny');
      const input = { command: 'npm test' };
      assert.equal((await permit('Bash', input, {})).message, '沿用原工具权限规则');
      assert.equal(fallback.at(-1).input, input);
      oldCallback = permit;
      await options.mcpServers.qq.instance.close();
      yield { type: 'result', subtype: 'success', result: '完成' };
    } });
  try {
    process.env.CLAUDE_ALLOWED_PATHS = dir;
    process.env.DENIED_TOOLS = '';
    await session.run('发图');
    assert.equal((await oldCallback(IMAGE_TOOL_NAME, { file_path: 'image.png' }, {})).behavior, 'deny');
    await session.run('再发图');
    assert.equal(fallback.length, 2);
  } finally {
    if (previousPaths === undefined) delete process.env.CLAUDE_ALLOWED_PATHS;
    else process.env.CLAUDE_ALLOWED_PATHS = previousPaths;
    if (previousDenied === undefined) delete process.env.DENIED_TOOLS;
    else process.env.DENIED_TOOLS = previousDenied;
  }
});

test('真实 MCP 工具列表始终加载 send_image；通过协议调用后才返回发图成功', async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, 'picture.png'), png);
  const sent = [];
  const controller = new AbortController();
  const server = imageServer({ workspace: dir, getAllowedPaths: () => [dir], getDeniedTools: () => [],
    getSignal: () => controller.signal, onImage: async (image) => sent.push(image) });
  const client = new Client({ name: 'image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.instance.close(); });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const image = tools.find((item) => item.name === 'send_image');
  assert.ok(image);
  assert.equal(image._meta['anthropic/alwaysLoad'], true);
  const result = await client.callTool({ name: 'send_image', arguments: { file_path: join(dir, 'picture.png') } });
  assert.ok(!result.isError);
  assert.deepEqual(sent, [picture]);
});

test('/image 直接发送当前聊天的本地图片：保留空格、支持 ~，不启动 Claude，越界/禁用拒绝', async (t) => {
  const dir = await directory(t);
  const outside = await directory(t);
  await writeFile(join(dir, 'screen shot.png'), png);
  await writeFile(join(outside, 'outside.png'), png);
  const store = new TicketStore(':memory:');
  t.after(() => store.close());
  store.create('chat:1', 'a', '截图', dir);
  const h = botHarness(store, () => { throw new Error('不应调用 Claude'); });
  h.bot.config.allowedPaths = [dir];
  h.bot.config.workspace = dir;
  const send = (text) => h.bot.handle({ chatKey: 'chat:1', userId: 'a', text, frame: { target: 'chat:1' } });
  await send(`/image "${join(dir, 'screen shot.png')}"`);
  await send('/image screen shot.png');
  await send(`/image ~/${relative(homedir(), join(dir, 'screen shot.png'))}`);
  assert.deepEqual(h.imageTargets, ['chat:1', 'chat:1', 'chat:1']);
  assert.equal(h.bot.sessions.size, 0);
  assert.equal(store.pending(1).length, 0);
  await send(`/image ${join(outside, 'outside.png')}`);
  assert.match(h.sent.at(-1), /范围/);
  h.bot.config.deniedTools = [IMAGE_TOOL_NAME];
  await send('/image screen shot.png');
  assert.match(h.sent.at(-1), /禁用/);
  assert.equal(h.imageTargets.length, 3);
  assert.equal(store.history(1).filter((r) => r.content.includes('通过 /image')).length, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readWorkspaceFile, fileBytes, fileReceipt, FILE_TOOL_NAME, MAX_FILE_BYTES } from '../src/files.js';
import { imageServer } from '../src/image-tool.js';
import { fileTool } from '../src/file-tool.js';
import { ClaudeSession } from '../src/claude.js';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { createToolGuard } from '../src/guard.js';

const logger = { info() {}, warn() {}, error() {} };
const pdf = Buffer.from('%PDF-1.7\ntest');
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('文件快照保留中文/空格文件名及原始字节；不根据扩展名改变内容', async (t) => {
  const dir = await directory(t);
  for (const name of ['报告 1.pdf', '表格.xlsx', 'source.zip', 'app.js']) {
    await writeFile(join(dir, name), pdf);
    const file = await readWorkspaceFile(name, dir, [dir]);
    assert.equal(file.name, name);
    assert.deepEqual(fileBytes(file), pdf);
  }
  assert.throws(() => fileBytes({ name: '../bad.txt', data: pdf.toString('base64') }), /文件名/);
  assert.throws(() => fileBytes({ name: 'bad.txt', data: 'bad\nbase64' }), /文件数据/);
  assert.throws(() => fileReceipt({}), /无法确认/);
});

test('文件拒绝越界、符号链接越界、目录、空文件、超限、允许目录收紧', async (t) => {
  const dir = await directory(t), outside = await directory(t);
  await writeFile(join(outside, 'private.pdf'), pdf);
  await symlink(join(outside, 'private.pdf'), join(dir, 'escape.pdf'));
  await writeFile(join(dir, 'empty.txt'), '');
  await writeFile(join(dir, 'large.zip'), 'x');
  await truncate(join(dir, 'large.zip'), MAX_FILE_BYTES + 1);
  await writeFile(join(dir, 'report.pdf'), pdf);
  await assert.rejects(readWorkspaceFile('escape.pdf', dir, '*'), /范围/);
  await assert.rejects(readWorkspaceFile(join(outside, 'private.pdf'), dir, '*'), /范围/);
  await assert.rejects(readWorkspaceFile('report.pdf', dir, [outside]), /范围/);
  await assert.rejects(readWorkspaceFile('.', dir, [dir]), /普通文件/);
  await assert.rejects(readWorkspaceFile('empty.txt', dir, [dir]), /非空/);
  await assert.rejects(readWorkspaceFile('large.zip', dir, [dir]), /10 MiB/);
  const guard = createToolGuard({ workspace: dir, allowedPaths: [dir], deniedTools: [] });
  assert.equal((await guard({ tool_name: FILE_TOOL_NAME, tool_input: { file_path: '/outside/x' } })).hookSpecificOutput.permissionDecision, 'deny');
});

test('/file 不调用模型，绑定当前聊天和工单目录，支持 ~ 与空格；成功/失败回执如实记录', async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, '报告 1.pdf'), pdf);
  const store = new TicketStore(':memory:');
  t.after(() => store.close());
  store.create('chat:1', 'a', '报告', dir);
  const sent = [], uploads = [];
  const config = { workspace: dir, allowedPaths: [dir], deniedTools: [] };
  const bot = new TicketBot({ store, config, logger,
    createSession: () => { throw new Error('不应调用模型'); },
    send: async (_frame, text) => sent.push(text),
    sendFile: async (frame, file) => { uploads.push({ frame, file }); return { status: 'accepted' }; },
  });
  const command = (text, chatKey = 'chat:1') => bot.handle({ text, chatKey, userId: 'a', frame: { target: chatKey } });
  await command('/file 报告 1.pdf');
  await command(`/file "${join(dir, '报告 1.pdf')}"`);
  await command(`/file ~/${relative(homedir(), join(dir, '报告 1.pdf'))}`);
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((entry) => entry.frame.target === 'chat:1' && entry.file.name === '报告 1.pdf'));
  assert.match(sent.at(-1), /已接受/);
  assert.equal(store.history(1).filter((m) => m.content.includes('通过 /file')).length, 3);
  assert.equal(bot.sessions.size, 0);
  config.deniedTools = [FILE_TOOL_NAME];
  await command('/file 报告 1.pdf');
  assert.match(sent.at(-1), /禁用/);
  assert.equal(uploads.length, 3);
  config.deniedTools = [];
  bot.sendFile = async () => { throw new Error('平台不支持普通文件'); };
  await command('/file 报告 1.pdf');
  assert.match(sent.at(-1), /平台不支持/);
  assert.equal(store.history(1).length, 3);
});

test('文件 MCP 始终可发现，正确发送回执；停止/禁用/平台失败不声称成功', async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, 'report.pdf'), pdf);
  const controller = new AbortController();
  let uploads = 0;
  const opts = { workspace: dir, getAllowedPaths: () => [dir], getDeniedTools: () => [],
    getSignal: () => controller.signal, onFile: async () => { uploads++; return { status: 'sent', messageId: 'm1' }; } };
  const server = imageServer(opts);
  const client = new Client({ name: 'file-test', version: '1.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.instance.close(); });
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['send_file']);
  assert.equal(tools[0]._meta['anthropic/alwaysLoad'], true);
  const success = await client.callTool({ name: 'send_file', arguments: { file_path: 'report.pdf' } });
  assert.ok(!success.isError);
  assert.match(success.content[0].text, /已发送/);
  assert.equal(uploads, 1);
  const unavailable = await fileTool({ ...opts, onFile: async () => { throw new Error('QQ HTTP 400 code=123'); } }).handler({ file_path: 'report.pdf' });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /未能确认/);
  assert.equal((await fileTool({ ...opts, getDeniedTools: () => [FILE_TOOL_NAME] }).handler({ file_path: 'report.pdf' })).isError, true);
  controller.abort();
  assert.equal((await client.callTool({ name: 'send_file', arguments: { file_path: 'report.pdf' } })).isError, true);
  assert.equal(uploads, 1);
});

test('Claude 文件工具走统一权限回调；有效文件无额外审批，其他工具保持原规则，旧轮次拒绝', async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, 'report.pdf'), pdf);
  const beforePaths = process.env.CLAUDE_ALLOWED_PATHS, beforeDenied = process.env.DENIED_TOOLS;
  let callback, input;
  const session = new ClaudeSession({ workspace: dir, chatKey: 'c', logger,
    onFile: async () => ({ status: 'sent' }), canUseTool: async () => ({ behavior: 'deny', message: '原规则' }),
    queryFn: async function* ({ prompt, options }) {
      for await (const message of prompt) input = message.message.content[0].text;
      assert.match(input, /mcp__qq__send_file/);
      assert.match(input, /本轮未提供图片/);
      assert.equal(options.allowedTools, undefined);
      callback = options.canUseTool;
      assert.equal((await callback(FILE_TOOL_NAME, { file_path: 'report.pdf' }, {})).behavior, 'allow');
      assert.equal((await callback(FILE_TOOL_NAME, { file_path: '/outside/report.pdf' }, {})).behavior, 'deny');
      assert.equal((await callback('Bash', {}, {})).message, '原规则');
      process.env.DENIED_TOOLS = FILE_TOOL_NAME;
      assert.equal((await callback(FILE_TOOL_NAME, { file_path: 'report.pdf' }, {})).behavior, 'deny');
      process.env.DENIED_TOOLS = '';
      await options.mcpServers.qq.instance.close();
      yield { type: 'result', subtype: 'success', result: '完成' };
    } });
  try {
    process.env.CLAUDE_ALLOWED_PATHS = dir;
    process.env.DENIED_TOOLS = '';
    await session.run('发文件');
    assert.equal((await callback(FILE_TOOL_NAME, { file_path: 'report.pdf' }, {})).behavior, 'deny');
  } finally {
    if (beforePaths === undefined) delete process.env.CLAUDE_ALLOWED_PATHS; else process.env.CLAUDE_ALLOWED_PATHS = beforePaths;
    if (beforeDenied === undefined) delete process.env.DENIED_TOOLS; else process.env.DENIED_TOOLS = beforeDenied;
  }
});

test('模型发文件绑定执行中工单的聊天，不能因选中工单改变目标，结束后拒绝迟到发送', async (t) => {
  const dir = await directory(t);
  const store = new TicketStore(':memory:');
  t.after(() => store.close());
  const targets = [];
  let callback;
  const bot = new TicketBot({ store, logger, config: { workspace: dir, allowedPaths: [dir] },
    send: async () => {}, createProgress: () => ({ push: async () => {}, finish: async () => {} }),
    sendFile: async (frame) => { targets.push(frame.target); return { status: 'sent' }; },
    createSession: (opts) => ({ run: async () => { callback = opts.onFile; await callback({ name: 'x.pdf', data: 'x' }); return '完成'; } }),
  });
  await bot.handle({ text: '生成文件发回来', chatKey: 'chat:1', userId: 'a', frame: { target: 'chat:1' } });
  await bot.drainPromise;
  assert.deepEqual(targets, ['chat:1']);
  assert.ok(store.history(1).some((r) => r.content.includes('文件消息已发送')));
  await assert.rejects(callback({}), /停止/);
});

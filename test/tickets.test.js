import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketStore } from '../src/tickets.js';
import { TicketBot } from '../src/ticket-bot.js';
import { appendTrace, traceEntry, renderTrace } from '../src/verbose.js';
import { renderResult } from '../src/ticket-result.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(t, run = async () => '已处理', store = new TicketStore(':memory:')) {
  const sent = [];
  const calls = [];
  const sessions = [];
  const bot = new TicketBot({
    store,
    config: {
      workspace: '/workspace', allowedPaths: ['/workspace'], permissionMode: 'auto',
      approvalTimeoutMs: 10000, sessionTtlMs: 1, readOnlyTools: [],
    },
    logger: { error() {}, warn() {} },
    send: async (frame, text) => { sent.push({ frame, text }); },
    createProgress: (frame) => ({
      push: async () => {}, finish: async (text) => { sent.push({ frame, text }); },
    }),
    createSession: (options) => {
      const session = {
        ...options, idleMs: 100, busy: false, aborted: false,
        isBusy() { return this.busy; },
        abort() { this.aborted = true; return this.busy; },
        async run(prompt) {
          this.busy = true;
          this.sessionId ||= `session-${sessions.length}`;
          options.onSessionId(this.sessionId);
          calls.push({ prompt, session: this, options });
          try { return await run(prompt, this, options); }
          finally { this.busy = false; }
        },
      };
      sessions.push(session);
      return session;
    },
  });
  const send = (text, chatKey = 'user:a') => bot.handle({ text, chatKey, userId: chatKey, frame: { chatKey } });
  t.after(async () => {
    bot.shutdown();
    await bot.drainPromise;
    store.close();
  });
  return { bot, store, send, sent, calls, sessions };
}

test('result 全文分页不调用模型，导航固定回复，跨聊天/工单无法读取', async (t) => {
  const answer = '中文🧪段落\n'.repeat(900);
  const h = harness(t, async () => answer);
  h.bot.config.transport = 'official';
  h.bot.config.messageMaxBytes = 3800;
  await h.send('/new 测试长结果');
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent.length, 2); // confirmation + first page only
  assert.ok(Buffer.byteLength(h.sent.at(-1).text) <= 3800);
  assert.match(h.sent.at(-1).text, /下一页：\/result 1 2/);
  const result = h.store.result(1);
  assert.equal(result.content, answer);
  await h.send('/result 1');
  assert.equal(h.sent.at(-1).text, renderResult(1, result));
  const oldNavigation = /下一页：(.*)$/.exec(h.sent.at(-1).text)[1];
  h.store.addMessage(1, 'assistant', '后续新结果');
  await h.send(oldNavigation);
  assert.equal(h.sent.at(-1).text, renderResult(1, result, 2));
  await h.send('/result');
  assert.match(h.sent.at(-1).text, /后续新结果/);
  await h.send('/result 1 9999');
  assert.match(h.sent.at(-1).text, /页码超出/);
  for (const invalid of ['/result 1 0', '/result 1 2 extra', '/result 9007199254740992']) {
    await h.send(invalid);
    assert.match(h.sent.at(-1).text, /用法/);
  }
  await h.send(`/result 1 1 ${result.id}`, 'user:b');
  assert.match(h.sent.at(-1).text, /不属于当前聊天/);
  const other = h.store.create('user:a', 'a', '第二工单', '/workspace');
  await h.send(`/result ${other.id} 1 ${result.id}`);
  assert.match(h.sent.at(-1).text, /不属于此工单/);
  await h.send(`/result ${other.id}`);
  assert.match(h.sent.at(-1).text, /尚无已保存/);
  assert.equal(h.calls.length, 1);
});

test('结果分页在最小消息预算下不拆坏 Unicode，拼接恢复全文', () => {
  const message = { id: 9007199254740991, content: '中🧪文\n'.repeat(1000) };
  const ticket = 9007199254740991;
  for (const limit of [256, 3800]) {
    const first = renderResult(ticket, message, 1, limit);
    const count = Number(/ · 1\/(\d+)/.exec(first)[1]);
    const contents = [];
    for (let page = 1; page <= count; page++) {
      const reply = renderResult(ticket, message, page, limit);
      assert.ok(Buffer.byteLength(reply) <= limit);
      contents.push(reply.slice(reply.indexOf('\n\n') + 2).replace(/\n\n下一页：.*$/, ''));
    }
    assert.equal(contents.join(''), message.content);
  }
});

test('旧数据库已保存回复重启后可直接 result 取回，无需 resume', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-results-'));
  const path = join(directory, 'tickets.sqlite');
  let old = new TicketStore(path);
  const ticket = old.create('user:a', 'a', '旧工单', '/workspace');
  old.addMessage(ticket.id, 'assistant', '保存在数据库中的完整结果。');
  old.setStatus(ticket.id, 'review');
  old.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = harness(t, async () => { throw new Error('不应调用模型'); }, new TicketStore(path));
  await h.send('/result 1');
  assert.match(h.sent.at(-1).text, /完整结果/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.get(ticket.id).status, 'review');
});

test('verbose 默认关闭、按聊天隔离，开启后只发送折叠入口，show 无需调用模型', async (t) => {
  const h = harness(t, async (_prompt, session) => {
    session.onEvent({ kind: 'thinking', text: '检查测试覆盖范围。' });
    session.onEvent({ kind: 'tool_use', toolName: 'Bash', input: { command: 'secret argument' } });
    return '已完成验证';
  });
  await h.send('/verbose');
  assert.match(h.sent.at(-1).text, /已关闭/);
  await h.send('默认不开启');
  await h.bot.drainPromise;
  assert.equal(h.store.latestTrace(1), null);
  await h.send('/verbose  on');
  assert.equal(h.store.verboseEnabled('user:a'), true);
  assert.equal(h.store.verboseEnabled('user:b'), false);
  await h.send('再次检查');
  await h.bot.drainPromise;
  assert.match(h.sent.at(-1).text, /执行摘要已折叠/);
  assert.match(h.sent.at(-1).text, /已完成验证/);
  assert.doesNotMatch(h.sent.map((m) => m.text).join('\n'), /检查测试覆盖范围|secret argument/);
  const calls = h.calls.length;
  await h.send('/verbose show');
  assert.match(h.sent.at(-1).text, /检查测试覆盖范围/);
  assert.match(h.sent.at(-1).text, /Bash/);
  assert.doesNotMatch(h.sent.at(-1).text, /secret argument/);
  assert.equal(h.calls.length, calls);
  await h.send('/verbose show 1', 'user:b');
  assert.match(h.sent.at(-1).text, /不属于当前聊天/);
  await h.send('/verbose nonsense');
  assert.match(h.sent.at(-1).text, /用法/);
  await h.send('/verbose off');
  await h.send('不记录新一轮');
  await h.bot.drainPromise;
  assert.equal(h.store.latestTrace(1), null);
  assert.doesNotMatch(h.sent.at(-1).text, /已折叠/);
});

test('执行中开关即时生效，show 优先活动工单，停止和迟到事件不会追加摘要', async (t) => {
  const gate = deferred();
  let event;
  const h = harness(t, async (_prompt, session) => {
    event = session.onEvent;
    await gate.promise;
    return '完成';
  });
  t.after(() => gate.resolve());
  await h.send('慢任务');
  await h.send('/verbose on');
  event({ kind: 'thinking', text: '本轮已开始检查。' });
  await h.send('排队的补充不能遮住正在执行的摘要');
  const another = h.store.create('user:a', 'user:a', '其他工单', '/workspace');
  assert.equal(another.id, 2);
  await h.send('/verbose show');
  assert.match(h.sent.at(-1).text, /工单 #1/);
  assert.match(h.sent.at(-1).text, /本轮已开始检查/);
  await h.send('/verbose off');
  event({ kind: 'thinking', text: '关闭后不记录' });
  await h.send('/verbose on');
  await h.send('/stop 1');
  event({ kind: 'thinking', text: '停止后不记录' });
  gate.resolve();
  await h.bot.drainPromise;
  event({ kind: 'thinking', text: '运行结束后不记录' });
  const trace = h.store.latestTrace(1);
  assert.equal(trace.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(trace), /不记录/);
});

test('verbose 配置和摘要可跨数据库重启保存，旧库自动创建表', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-verbose-'));
  const path = join(directory, 'tickets.sqlite');
  let store;
  try {
    store = new TicketStore(path);
    store.db.exec('DROP TABLE job_traces; DROP TABLE chat_settings;');
    store.close();
    store = new TicketStore(path);
    const ticket = store.create('user:a', 'a', '任务', '/workspace');
    const job = store.enqueue(ticket.id, '执行');
    store.setVerbose('user:a', true);
    store.saveTrace(job, { entries: ['已请求读取文件'], dropped: 0 });
    store.close();
    store = new TicketStore(path);
    assert.equal(store.verboseEnabled('user:a'), true);
    assert.equal(store.verboseEnabled('user:b'), false);
    assert.deepEqual(store.latestTrace(ticket.id), { entries: ['已请求读取文件'], dropped: 0 });
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('摘要限制持久化大小、过滤凭据，不发送工具参数，分页不耗尽回复预算', () => {
  const old = process.env.QQBOT_APP_SECRET;
  process.env.QQBOT_APP_SECRET = 'test-secret-verbose';
  try {
    assert.doesNotMatch(traceEntry({ kind: 'thinking', text: 'token: test-secret-verbose' }), /test-secret-verbose/);
    assert.equal(traceEntry({ kind: 'redacted_thinking', text: 'hidden' }), null);
    assert.doesNotMatch(traceEntry({ kind: 'tool_use', toolName: 'Read', input: { file_path: 'secret-path' } }), /secret-path/);
    const trace = { entries: [], dropped: 0 };
    for (let i = 0; i < 50; i++) appendTrace(trace, traceEntry({ kind: 'thinking', text: '进度🧪'.repeat(2000) }));
    assert.ok(trace.dropped > 0);
    assert.ok(Buffer.byteLength(trace.entries.join('\n\n')) <= 24000);
    for (const limit of [256, 3800]) {
      const first = renderTrace(123, trace, 1, limit);
      assert.ok(Buffer.byteLength(first) <= limit);
      assert.match(first, /下一页/);
      assert.ok(Buffer.byteLength(renderTrace(123, trace, 2, limit)) <= limit);
    }
    assert.throws(() => renderTrace(123, trace, 10000), /页码超出范围/);
  } finally {
    if (old === undefined) delete process.env.QQBOT_APP_SECRET;
    else process.env.QQBOT_APP_SECRET = old;
  }
});

test('工单各自保存上下文，切换与内存回收后仍恢复原会话', async (t) => {
  const h = harness(t);
  await h.send('/new 修复登录');
  await h.bot.drainPromise;
  const firstSession = h.store.get(1).session_id;
  await h.send('/new 订单缓存');
  await h.bot.drainPromise;
  assert.notEqual(h.store.get(2).session_id, firstSession);
  h.bot.evictIdle();
  assert.equal(h.bot.sessions.size, 0);
  await h.send('/switch 1');
  await h.send('只修改后端');
  await h.bot.drainPromise;
  assert.equal(h.calls[2].session.sessionId, firstSession);
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.history(1).filter((m) => m.role === 'user').length, 2);
  assert.equal(h.store.history(2).filter((m) => m.role === 'user').length, 1);
});

test('执行中新增工单和补充需求全部串行，消息归属提交时的工单', async (t) => {
  const gate = deferred();
  let count = 0;
  const h = harness(t, async () => { if (++count === 1) await gate.promise; return '完成'; });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('/new B');
  await h.send('B 的补充');
  await h.send('/switch 1');
  await h.send('A 的补充');
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[1].prompt, /B/);
  assert.equal(h.calls[2].prompt, 'B 的补充');
  assert.equal(h.calls[3].prompt, 'A 的补充');
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.get(2).status, 'review');
});

test('工单按聊天隔离，其他聊天不能查看、切换、关闭或停止', async (t) => {
  const h = harness(t);
  await h.send('/new 私有需求');
  await h.bot.drainPromise;
  for (const command of ['switch', 'status', 'history', 'close', 'stop', 'resume', 'reset']) {
    await h.send(`/${command} 1`, 'user:b');
    assert.match(h.sent.at(-1).text, /不属于当前聊天/);
  }
  await h.send('/list', 'user:b');
  assert.doesNotMatch(h.sent.at(-1).text, /私有需求/);
  assert.equal(h.store.get(1).status, 'review');
});

test('审批绑定工单与随机编号，切换后裸 y、错号和跨聊天回复均不能批准', async (t) => {
  const entered = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (!session.chatKey.endsWith('ticket:1')) return '完成';
    const result = session.canUseTool('Bash', { command: 'npm test' }, {});
    entered.resolve();
    const decision = await result;
    assert.equal(decision.behavior, 'allow');
    return '已执行';
  });
  await h.send('/new 测试审批');
  await entered.promise;
  const pending = h.bot.approvals.getPending('user:a');
  assert.match(pending.id, /^1-/);
  assert.equal(h.store.get(1).status, 'approval');
  await h.send('/new 另一个工单');
  for (const reply of ['y', 'y 1-old', `y ${pending.id} extra`]) {
    await h.send(reply);
    assert.ok(h.bot.approvals.hasPending('user:a'));
  }
  await h.send(`y ${pending.id}`, 'user:b');
  assert.ok(h.bot.approvals.hasPending('user:a'));
  await h.send(`y ${pending.id}`);
  await h.bot.drainPromise;
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.get(2).status, 'review');
  const count = h.calls.length;
  await h.send(`y ${pending.id}`);
  assert.equal(h.calls.length, count);
  assert.match(h.sent.at(-1).text, /没有待审批/);
});

test('停止必须等旧运行退出才启动下一工单，关闭和重置不能越过活动任务', async (t) => {
  const gate = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (session.chatKey.endsWith('ticket:1')) await gate.promise;
    return '完成';
  });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('待取消的补充');
  await h.send('/close');
  assert.match(h.sent.at(-1).text, /尚有任务/);
  await h.send('/new B');
  await h.send('/stop');
  assert.equal(h.sessions[0].aborted, true);
  await h.send('/reset 1');
  assert.match(h.sent.at(-1).text, /等待执行退出/);
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.get(1).status, 'stopped');
  await h.send('/close 1');
  assert.equal(h.store.get(1).status, 'closed');
  await h.send('/switch 1');
  await h.send('新的需求');
  await h.bot.drainPromise;
  assert.equal(h.store.current('user:a').id, 3);
});

test('重启保留会话和消息，暂停未完成任务，只有 /resume 才恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tickets.sqlite');
  const before = new TicketStore(path);
  const ticket = before.create('user:a', 'a', '重启恢复', '/workspace');
  before.setSession(ticket.id, 'persisted-session');
  const first = before.enqueue(ticket.id, '原始需求');
  before.jobState(first, 'running');
  before.setStatus(ticket.id, 'approval');
  before.enqueue(ticket.id, '排队补充');
  before.close();
  const store = new TicketStore(path);
  const h = harness(t, undefined, store);
  assert.equal(store.current('user:a').id, ticket.id);
  assert.equal(store.get(ticket.id).status, 'stopped');
  assert.equal(store.nextJob(), undefined);
  await h.send('重启后的补充');
  assert.equal(h.calls.length, 0);
  await h.send('/resume');
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].session.sessionId, 'persisted-session');
  assert.match(h.calls[0].prompt, /先核查已完成/);
  assert.match(h.calls[0].prompt, /原始需求/);
  assert.match(h.calls[2].prompt, /重启后的补充/);
  assert.equal(store.get(ticket.id).status, 'review');
});

test('失败不会标为待验收，同工单补充暂停，其他工单仍可继续', async (t) => {
  const gate = deferred();
  const h = harness(t, async (_prompt, session) => {
    if (session.chatKey.endsWith('ticket:1')) {
      await gate.promise;
      session.lastRunSucceeded = false;
      return '超过轮数上限';
    }
    return '完成';
  });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('A 补充');
  await h.send('/new B');
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.store.get(1).status, 'failed');
  assert.equal(h.store.pending(1)[0].state, 'paused');
  assert.equal(h.store.get(2).status, 'review');
});

test('进程退出保存未完成任务为暂停，绝不启动下一工单', async (t) => {
  const gate = deferred();
  const h = harness(t, async () => { await gate.promise; return '停止后的迟到结果'; });
  t.after(() => gate.resolve());
  await h.send('/new A');
  await h.send('/new B');
  h.bot.shutdown();
  gate.resolve();
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.get(1).status, 'stopped');
  assert.equal(h.store.pending(1)[0].state, 'paused');
  assert.equal(h.store.pending(2)[0].state, 'queued');
  assert.ok(h.store.get(1).session_id);
});

test('并发审批不取代已有请求，超时拒绝且旧编号不再生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  let firstDecision;
  const h = harness(t, async (_prompt, session) => {
    const first = session.canUseTool('Bash', { command: 'npm test' }, {});
    const second = await session.canUseTool('Bash', { command: 'npm run build' }, {});
    assert.equal(second.behavior, 'deny');
    entered.resolve();
    firstDecision = await first;
    return '操作已拒绝';
  });
  await h.send('/new 审批超时');
  await entered.promise;
  const id = h.bot.approvals.getPending('user:a').id;
  t.mock.timers.tick(10000);
  await h.bot.drainPromise;
  assert.equal(firstDecision.behavior, 'deny');
  assert.equal(firstDecision.message, '审批超时');
  await h.send(`y ${id}`);
  assert.match(h.sent.at(-1).text, /没有待审批/);
});

test('队列刚结束时到达的新消息也会启动，不需要下一条消息唤醒', async (t) => {
  const h = harness(t);
  h.bot.kick(); // 空队列已经返回，但 finally 尚未执行。
  await h.send('/new 刚好到达');
  // kick 的 finally 可以接续一个新的 drainPromise。
  while (h.bot.draining) await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.get(1).status, 'review');
});

test('需求确认发送失败时已保存工单仍会执行，不滞留在队列', async (t) => {
  const h = harness(t);
  h.bot.send = async () => { throw new Error('QQ offline'); };
  await h.send('/new 检查状态');
  await h.bot.drainPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.get(1).status, 'review');
  assert.equal(h.store.pending(1).length, 0);
});

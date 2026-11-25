import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoginPage, waitForLogin, updateBinding, saveBinding } from '../src/qq-login.js';

function fakeClient() {
  const client = new EventEmitter();
  client.connect = () => { client.connects = (client.connects || 0) + 1; };
  client.disconnect = () => { client.disconnects = (client.disconnects || 0) + 1; };
  return client;
}

test('扫码登录检测成功后关闭连接，不留监听器；未认证不会完成', async () => {
  const client = fakeClient();
  const login = waitForLogin(client);
  client.emit('warning', 'not logged in');
  client.emit('disconnected');
  assert.equal(client.disconnects, undefined);
  client.emit('ready', '12345');
  assert.equal(await login, '12345');
  assert.equal(client.disconnects, 1);
  assert.equal(client.listenerCount('ready'), 0);
});

test('登录超时、取消、无效账号均拒绝并释放连接', async () => {
  const timeoutClient = fakeClient();
  await assert.rejects(waitForLogin(timeoutClient, { timeoutMs: 5 }), /超时/);
  assert.equal(timeoutClient.disconnects, 1);
  const client = fakeClient();
  const controller = new AbortController();
  const cancelled = waitForLogin(client, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /取消/);
  assert.equal(client.disconnects, 1);
  const alreadyCancelled = fakeClient();
  await assert.rejects(waitForLogin(alreadyCancelled, { signal: controller.signal }), /取消/);
  assert.equal(alreadyCancelled.connects, undefined);
  const invalid = fakeClient();
  const login = waitForLogin(invalid);
  invalid.emit('ready', 'not-a-qq');
  await assert.rejects(login, /无效/);
  assert.equal(invalid.disconnects, 1);
});

test('绑定只更新机器人 ID，保留 token、操作者白名单、注释及 CRLF，消除重复键', () => {
  const source = '# config\r\nONEBOT_ACCESS_TOKEN="keep#secret"\r\nQQ_ALLOWED_USER_IDS=456\r\n export QQ_BOT_ID = 1\r\nQQ_BOT_ID=2\r\n';
  assert.equal(updateBinding(source, '789'), '# config\r\nONEBOT_ACCESS_TOKEN="keep#secret"\r\nQQ_ALLOWED_USER_IDS=456\r\nQQ_BOT_ID=789\r\n');
  assert.equal(updateBinding('X=1', '789'), 'X=1\nQQ_BOT_ID=789\n');
  assert.throws(() => updateBinding(source, '789\nOTHER=value'), /无效/);
});

test('绑定写入 .env 使用受限权限，并保留扫码期间修改的配置', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  await writeFile(path, 'QQ_BOT_ID=1\nCLAUDE_WORKSPACE=/changed\n');
  await saveBinding(path, '789');
  assert.equal(await readFile(path, 'utf8'), 'QQ_BOT_ID=789\nCLAUDE_WORKSPACE=/changed\n');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['.env']);
});

test('浏览器打开使用参数数组，无桌面平台可以手动打开', async () => {
  const calls = [];
  await openLoginPage('http://127.0.0.1:6099/', { platform: 'darwin', run: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [['open', ['http://127.0.0.1:6099/']]]);
  await assert.rejects(openLoginPage('http://127.0.0.1:6099/', { platform: 'win32' }), /手动/);
});

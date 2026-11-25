import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createCipheriv, randomBytes } from 'node:crypto';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import { connectByQr } from '../src/official-login.js';

test('实际下载的 SDK：生成终端二维码、加密凭据轮询、回调绑定；不输出 AppSecret', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  let bindKey;
  const requests = [];
  t.mock.method(https, 'request', (options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = (raw) => {
      const body = JSON.parse(raw);
      requests.push({ hostname: options.hostname, path: options.path });
      let result;
      if (options.path === '/lite/create_bind_task') {
        bindKey = Buffer.from(body.key, 'base64');
        result = { retcode: 0, data: { task_id: 'test-task' } };
      } else {
        assert.equal(options.path, '/lite/poll_bind_result');
        assert.equal(body.task_id, 'test-task');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', bindKey, iv);
        const encrypted = Buffer.concat([iv, cipher.update('test-app-secret'), cipher.final(), cipher.getAuthTag()]);
        result = { retcode: 0, data: { status: 2, bot_appid: '12345',
          bot_encrypt_secret: encrypted.toString('base64'), user_openid: 'USER_A' } };
      }
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit('data', JSON.stringify(result));
        response.emit('end');
      });
    };
    return request;
  });
  const credentials = await connectByQr(startQrConnect);
  assert.deepEqual(credentials, { appId: '12345', appSecret: 'test-app-secret', userOpenid: 'USER_A' });
  assert.deepEqual(requests.map((r) => r.path), ['/lite/create_bind_task', '/lite/poll_bind_result']);
  assert.ok(requests.every((r) => r.hostname === 'q.qq.com'));
  assert.ok(logs.length >= 2);
  assert.ok(logs.some((text) => text.includes('手机 QQ')));
  assert.ok(logs.every((text) => !text.includes('test-app-secret')));
});

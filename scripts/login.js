import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import { connectByQr, saveOfficialBinding } from '../src/official-login.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`用法：npm run login [-- --app-id 应用ID]

通过 @tencent-connect/qqbot-connector 在终端展示 QQ 机器人授权二维码。
使用手机 QQ 扫码并确认，成功后保存 AppID / AppSecret 到 .env（权限 0600）。
无需 NapCat、OneBot token 或提前填写 AppSecret。
当前 SDK 一次返回一个机器人；多个结果时可用 --app-id 选择。
等待最长 10 分钟，Ctrl+C 取消。二维码过期由 SDK 自动刷新。

扫码得到的是 QQ 开放平台机器人凭据，不是个人 QQ 登录态。
可用群聊、私聊、主动推送权限由 QQ 平台决定。
旧 NapCat 方式使用 npm run login:onebot。`);
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    if (args.length && !(args.length === 2 && args[0] === '--app-id' && /^[1-9]\d*$/.test(args[1]))) {
      throw new Error('参数无效，使用 npm run login -- --help 查看用法');
    }
    console.log('请先停止桥接进程。正在获取 QQ 机器人绑定二维码…');
    const credentials = await connectByQr(startQrConnect, { signal: controller.signal, appId: args[1] });
    if (controller.signal.aborted) throw new Error('已取消，凭据未保存');
    const saved = await saveOfficialBinding(resolve('.env'), credentials, {
      templatePath: fileURLToPath(new URL('../.env.example', import.meta.url)),
    });
    console.log(`QQ 机器人绑定成功，AppID：${saved.appId}。凭据已保存至 .env。`);
    console.log(saved.needsAllowlist
      ? '本次 SDK 未返回操作者 OpenID。请将 QQBOT_ALLOWED_USER_IDS 配置为自己的 OpenID；当前占位白名单拒绝所有人。'
      : '操作者白名单已保存或沿用；群聊默认禁用，新应用需单独配置群 OpenID。');
    console.log('填写 CLAUDE_WORKSPACE 后执行 npm run check、npm start。');
  } catch (error) {
    // SDK errors are sanitized by connectByQr; filesystem errors carry no credentials.
    console.error(`绑定失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

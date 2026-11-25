import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { OneBotClient } from '../src/onebot.js';
import { openLoginPage, waitForLogin, saveBinding } from '../src/qq-login.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`用法：npm run login:onebot [-- --no-open]

先运行 NapCat 并启用 OneBot v11 正向 WebSocket。
复制 .env.example 为 .env，填写 ONEBOT_WS_URL、ONEBOT_ACCESS_TOKEN 和 NAPCAT_WEBUI_URL。
本命令打开 NapCat WebUI：输入 WebUI token 后，用手机 QQ 扫码并确认登录。
检测到 OneBot 登录成功后，将机器人 QQ 号写入 .env 的 QQ_BOT_ID。
已有登录态时直接绑定该账号；切换账号请先在 NapCat 中退出旧账号。
--no-open 仅打印登录页地址，适合远程或无桌面环境。

绑定前请停止正在运行的桥接。等待最长 10 分钟，Ctrl+C 取消。
本命令不启动 Claude、不发送 QQ 消息；控制者 QQ 白名单仍需单独填写。`);
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    if (args.some((arg) => arg !== '--no-open')) throw new Error('未知参数，使用 npm run login:onebot -- --help 查看用法');
    const envPath = resolve('.env');
    try { await access(envPath); }
    catch { throw new Error('请先 cp .env.example .env，填写 OneBot 地址及 token，再运行 npm run login:onebot'); }
    const url = config.onebotUrl;
    const token = config.onebotToken;
    const webuiUrl = config.napcatWebuiUrl;
    console.log(`QQ 扫码登录页：${webuiUrl}`);
    console.log('请在 NapCat 页面输入 WebUI token，使用手机 QQ 扫码并确认。WebUI token 与 OneBot token 是两项独立配置。');
    console.log('已有登录态时将绑定当前账号；如需切换，请先在 NapCat 中退出旧账号。');
    if (!args.includes('--no-open')) {
      try { await openLoginPage(webuiUrl); }
      catch { console.log('未能自动打开浏览器，请手动打开上面的地址。'); }
    }
    const client = new OneBotClient({ url, token });
    let lastWarning = 0;
    client.on('warning', () => {
      if (Date.now() - lastWarning < 30000) return;
      lastWarning = Date.now();
      console.log('尚未检测到登录成功；请完成扫码，并确认 NapCat 正向 WebSocket 已启用、地址和 token 正确。');
    });
    console.log('正在等待 QQ 登录，最长 10 分钟；Ctrl+C 取消…');
    const qqId = await waitForLogin(client, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error('已取消，未保存绑定');
    await saveBinding(envPath, qqId);
    console.log(`已绑定机器人 QQ：${qqId}，已保存到 .env（QQ_BOT_ID）。`);
    console.log('填好 QQ_ALLOWED_USER_IDS（操作者 QQ 号）和 CLAUDE_WORKSPACE 后，运行 npm run check 与 npm start。');
  } catch (error) {
    // Never include connection tokens or raw transport responses in diagnostics.
    let message = error.message;
    if (process.env.ONEBOT_ACCESS_TOKEN) message = message.replaceAll(process.env.ONEBOT_ACCESS_TOKEN, '[令牌已隐藏]');
    console.error(`绑定失败：${message}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

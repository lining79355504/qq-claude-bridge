import { config, validateConfig } from './config.js';
import { ClaudeSession } from './claude.js';
import { TicketStore } from './tickets.js';
import { TicketBot } from './ticket-bot.js';
import { ScheduleStore } from './schedule-store.js';
import { Scheduler } from './scheduler.js';
import { redactSecrets } from './schedule-delivery.js';
import { OneBotClient } from './onebot.js';
import { normalizeMessage, MessageDeduper } from './qq-message.js';
import { QQProgress } from './qq-progress.js';
import { OfficialClient } from './official-client.js';
import { prepareImages } from './images.js';
import { normalizeOfficialMessage } from './official-message.js';

const safe = (value) => {
  let text = redactSecrets(value instanceof Error ? value.message : String(value));
  for (const secret of [process.env.ONEBOT_ACCESS_TOKEN, process.env.QQBOT_APP_SECRET]) {
    if (secret) text = text.replaceAll(secret, '[凭据已隐藏]');
  }
  return text;
};
const log = Object.fromEntries(['info', 'warn', 'error'].map((level) =>
  [level, (...args) => console[level](`[${level}]`, ...args.map(safe))]));
try { validateConfig(); }
catch (error) { log.error(error); process.exit(1); }

const official = config.transport === 'official';
const client = official ? new OfficialClient({ appId: config.appId, appSecret: config.appSecret,
  allowProactive: config.allowProactive, sendIntervalMs: config.sendIntervalMs, messageMaxBytes: config.messageMaxBytes })
  : new OneBotClient({ url: config.onebotUrl, token: config.onebotToken,
    expectedSelfId: config.botQqId, sendIntervalMs: config.sendIntervalMs, messageMaxBytes: config.messageMaxBytes });
const store = new TicketStore(config.ticketDbPath);
const sendTo = (target, text) => client.sendMessage(target, redactSecrets(text));
const send = (frame, text) => sendTo(frame.target, text);
const sendImage = (target, image, options) => client.sendImage(target, image, options);
const sendFile = (target, file, options) => client.sendFile(target, file, options);
const downloads = new AbortController();
const scheduler = new Scheduler({
  store: new ScheduleStore(store), config, logger: log,
  createSession: (options) => new ClaudeSession(options),
  sendChat: sendTo, sendImage, sendFile, isChatReady: () => client.ready,
});
const bot = new TicketBot({
  store, config, logger: log, send,
  sendFile: (frame, file, options) => sendFile(frame.target, file, options),
  sendImage: (frame, image, options) => sendImage(frame.target, image, options),
  createProgress: (frame, ticket) => {
    const progress = new QQProgress({ send: (text) => send(frame, text), ticketId: ticket.id,
      intervalMs: config.progressIntervalMs, logger: log });
    // Official passive replies have a limited budget; preserve it for approvals and results.
    return official ? { push: async () => {}, finish: (text) => progress.finish(text) } : progress;
  },
  createSession: (options) => new ClaudeSession(options), scheduler,
});
const deduper = new MessageDeduper();
let stopping = false;
let inbound = Promise.resolve();
client.on('ready', (selfId) => {
  log.info(`QQ ${official ? "官方应用" : "账号"} ${selfId} 已连接｜工作目录 ${config.workspace}｜白名单 ${config.allowedUserIds.length} 人`);
  scheduler.tick();
});
client.on('warning', (message) => log.warn(message));
client.on('disconnected', () => log.warn(client.stopped ? 'QQ 连接已停止' : 'QQ 连接断开，将自动重连'));
client.on('message', (event) => {
  if (stopping) return;
  const message = official ? normalizeOfficialMessage(event, config, {
    onDenied: ({ userId, groupId }) => log.warn(`拒绝非白名单消息：用户 OpenID=${userId}${groupId ? `，群 OpenID=${groupId}` : ''}`),
  }) : normalizeMessage(event, config, client.selfId);
  if (!message || !deduper.accept(message.messageId)) return;
  if (official) client.rememberReply(message.frame);
  inbound = inbound.then(async () => {
    if (stopping) return;
    try {
      const images = await prepareImages(message.imageSources, { signal: downloads.signal });
      if (!stopping) await bot.handle({ ...message, images });
    } catch (error) {
      if (!stopping) await send(message.frame, `图片消息处理失败：${error.message}`);
    }
  })
    .catch((error) => log.error('消息处理失败', error));
});
const eviction = setInterval(() => bot.evictIdle(), 60000);
eviction.unref();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  downloads.abort();
  clearInterval(eviction);
  log.info('正在停止工单、定时任务和 QQ 连接…');
  const timeout = setTimeout(() => process.exit(1), 10000);
  bot.shutdown();
  const scheduledShutdown = scheduler.shutdown();
  try {
    await Promise.all([inbound, bot.drainPromise, scheduledShutdown]);
    client.disconnect();
    store.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) { log.error('退出失败', error); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
log.info(official ? '正在连接 QQ 官方机器人网关…' : '正在连接 OneBot 正向 WebSocket…');
client.connect();
scheduler.start();

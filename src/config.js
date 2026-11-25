import 'dotenv/config';
import { resolve, isAbsolute, parse } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 配置按需校验：字段第一次被读取时才检查，这样单个模块可以脱离完整 .env
 * 单独测试，同时启动时一读到必填项就会 fail-fast。
 */
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `缺少必填配置 ${name}，请在 .env 中填写（参考 .env.example）`,
    );
  }
  return value.trim();
}

function list(name, fallback = '') {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`配置 ${name} 必须是 true/false，当前值: ${raw}`);
}

function num(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`配置 ${name} 必须是正数，当前值: ${raw}`);
  }
  return parsed;
}

function integer(name, fallback, max) {
  const value = num(name, fallback);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`配置 ${name} 必须是 1 至 ${max} 的整数`);
  return value;
}

const READ_ONLY_DEFAULT = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
].join(',');

export const config = {
  get transport() {
    const value = process.env.QQ_TRANSPORT?.trim() || (process.env.ONEBOT_ACCESS_TOKEN?.trim() ? 'onebot' : 'official');
    if (!['official', 'onebot'].includes(value)) throw new Error('QQ_TRANSPORT 必须为 official 或 onebot');
    return value;
  },
  get appId() {
    const value = required('QQBOT_APP_ID');
    if (!/^[1-9]\d*$/.test(value)) throw new Error('QQBOT_APP_ID 必须是数字应用 ID');
    return value;
  },
  get appSecret() { return required('QQBOT_APP_SECRET'); },
  get allowProactive() { return bool('QQBOT_ALLOW_PROACTIVE', false); },

  get onebotUrl() {
    const value = process.env.ONEBOT_WS_URL?.trim() || 'ws://127.0.0.1:3001';
    let url;
    try { url = new URL(value); } catch { throw new Error('ONEBOT_WS_URL 必须是 WebSocket URL'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('ONEBOT_WS_URL 只接受 ws/wss 地址；令牌请填 ONEBOT_ACCESS_TOKEN');
    }
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('远程 OneBot 连接必须使用 wss，或通过 SSH 隧道连接本机端口');
    }
    return url.href;
  },
  get onebotToken() { return required('ONEBOT_ACCESS_TOKEN'); },
  get botQqId() {
    const value = process.env.QQ_BOT_ID?.trim() || '';
    if (value && !/^[1-9]\d*$/.test(value)) throw new Error('QQ_BOT_ID 必须是数字 QQ 号');
    return value;
  },
  get napcatWebuiUrl() {
    const value = process.env.NAPCAT_WEBUI_URL?.trim() || 'http://127.0.0.1:6099';
    let url;
    try { url = new URL(value); } catch { throw new Error('NAPCAT_WEBUI_URL 必须是 HTTP/HTTPS 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('NAPCAT_WEBUI_URL 不能包含账号、密码、查询参数或片段；WebUI token 请在页面输入');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('远程 NapCat 登录页必须使用 HTTPS，或通过 SSH 隧道访问');
    }
    return url.href;
  },
  get allowedUserIds() { return list(config.transport === 'official' ? 'QQBOT_ALLOWED_USER_IDS' : 'QQ_ALLOWED_USER_IDS'); },
  // 空群白名单表示禁用群聊。
  get allowedGroupIds() { return list(config.transport === 'official' ? 'QQBOT_ALLOWED_GROUP_IDS' : 'QQ_ALLOWED_GROUP_IDS'); },
  get groupRequireAt() { return bool('QQ_GROUP_REQUIRE_AT', true); },
  get progressIntervalMs() { return integer('QQ_PROGRESS_INTERVAL_MS', 15000, 2147483647); },
  get sendIntervalMs() { return integer('QQ_SEND_INTERVAL_MS', 1100, 60000); },
  get messageMaxBytes() {
    const value = integer('QQ_MESSAGE_MAX_BYTES', 3800, 3800);
    if (value < 256) throw new Error('QQ_MESSAGE_MAX_BYTES 至少为 256');
    return value;
  },

  // Claude Code 的工作目录，必须是明确配置的仓库目录。
  // 故意不回退到 process.cwd()——静默用错目录会让 Claude 改错仓库。
  get workspace() {
    const value = required('CLAUDE_WORKSPACE');
    if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root) {
      throw new Error('CLAUDE_WORKSPACE 必须是具体目录的绝对路径，不能使用 ~ 或根目录');
    }
    return resolve(value);
  },

  // 单次对话最多允许的 agent 轮数，防止死循环烧钱
  get maxTurns() {
    return integer('CLAUDE_MAX_TURNS', 30, 1000);
  },

  get permissionMode() {
    const mode = process.env.CLAUDE_PERMISSION_MODE?.trim() || 'default';
    if (!['default', 'acceptEdits', 'auto'].includes(mode)) {
      throw new Error('CLAUDE_PERMISSION_MODE 必须是 default、acceptEdits 或 auto');
    }
    return mode;
  },

  get ticketDbPath() {
    return process.env.TICKET_DB_PATH?.trim()
      ? resolve(process.env.TICKET_DB_PATH.trim())
      : fileURLToPath(new URL(config.transport === 'official'
        ? `../data/qqbot-${config.appId}.sqlite` : '../data/tickets.sqlite', import.meta.url));
  },

  get scheduleConcurrency() { return integer('SCHEDULE_CONCURRENCY', 4, 32); },
  get scheduleMaxTurns() { return integer('SCHEDULE_MAX_TURNS', 100, 1000); },
  get scheduleDeliveryConcurrency() { return integer('SCHEDULE_DELIVERY_CONCURRENCY', 4, 32); },
  get scheduleTimeoutMs() { return integer('SCHEDULE_TIMEOUT_MS', 30 * 60 * 1000, 2147483647); },
  get scheduleTimezone() {
    const timezone = process.env.SCHEDULE_TIMEZONE?.trim() || 'Asia/Shanghai';
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw new Error('SCHEDULE_TIMEZONE 必须是有效的 IANA 时区，例如 Asia/Shanghai'); }
    return timezone;
  },

  // 空闲会话仅回收内存对象；工单 sessionId 仍保存在数据库中
  get sessionTtlMs() {
    return num('SESSION_TTL_MS', 30 * 60 * 1000);
  },

  // 审批等待超时（毫秒），超时按拒绝处理
  get approvalTimeoutMs() {
    return num('APPROVAL_TIMEOUT_MS', 5 * 60 * 1000);
  },

  // 白名单工具：这些不需要审批，直接放行（只读/低风险）
  get readOnlyTools() {
    return list('READ_ONLY_TOOLS', READ_ONLY_DEFAULT);
  },

  // 明确禁止的工具，任何情况下都不执行
  get deniedTools() {
    return list('DENIED_TOOLS');
  },

  // Bash 里判定为纯只读的命令（ls/cat/grep/git status…）直接放行，不再弹审批。
  // 判定不了一律回落到人工审批，见 src/bash-policy.js。
  get autoApproveReadOnlyBash() {
    return bool('BASH_READONLY_AUTO_APPROVE', true);
  },

  // 允许读写的目录白名单。默认只有工作目录本身；
  // 想放开到父目录（比如同时操作 某个目录 下多个仓库）就显式配置。
  // 设为 "*" 表示不限制（不推荐）。
  get allowedPaths() {
    const raw = process.env.CLAUDE_ALLOWED_PATHS;
    if (raw && raw.trim() === '*') return '*';
    const extra = list('CLAUDE_ALLOWED_PATHS');
    return extra.length > 0
      ? extra.map((p) => resolve(p))
      : [config.workspace];
  },
};

export function validateConfig() {
  // 依次触发必填项校验
  if (config.transport === 'official') {
    config.appId;
    config.appSecret;
    config.allowProactive;
  } else {
    config.onebotUrl;
    config.onebotToken;
    config.botQqId;
  }
  config.allowedGroupIds;
  config.groupRequireAt;
  config.progressIntervalMs;
  config.sendIntervalMs;
  config.messageMaxBytes;
  config.workspace;
  if (!statSync(config.workspace).isDirectory()) throw new Error('CLAUDE_WORKSPACE 不是目录');
  config.maxTurns;
  config.permissionMode;
  config.sessionTtlMs;
  config.approvalTimeoutMs;
  config.scheduleConcurrency;
  config.scheduleMaxTurns;
  config.scheduleDeliveryConcurrency;
  config.scheduleTimeoutMs;
  config.scheduleTimezone;
  config.autoApproveReadOnlyBash;
  config.allowedPaths;

  for (const id of [...config.allowedUserIds, ...config.allowedGroupIds]) {
    const pattern = config.transport === 'official' ? /^[\w-]+$/ : /^[1-9]\d*$/;
    if (!pattern.test(id)) throw new Error('QQ 白名单格式无效：官方通道使用 OpenID，OneBot 使用数字 QQ 号');
  }
  if (config.allowedUserIds.length === 0) {
    throw new Error(
      `${config.transport === 'official' ? 'QQBOT_ALLOWED_USER_IDS' : 'QQ_ALLOWED_USER_IDS'} 为空，必须填写操作者白名单。`,
    );
  }
}

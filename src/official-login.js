import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

// SDK 1.2.0 returns an array; userOpenid exists in the implementation but is not
// in its public .d.ts. Treat it as optional and keep access denied if absent.
export function selectCredentials(rows, appId) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('扫码未返回机器人凭据');
  const row = appId ? rows.find((r) => r?.appId === appId) : rows.length === 1 ? rows[0] : null;
  if (!row) throw new Error('返回多个机器人或未找到指定应用，请使用 --app-id 指定应用');
  if (typeof row.appId !== 'string' || !/^[1-9]\d*$/.test(row.appId) || typeof row.appSecret !== 'string'
    || !row.appSecret || /[\x00-\x1f]/.test(row.appSecret)) throw new Error('扫码返回的凭据无效');
  return { appId: row.appId, appSecret: row.appSecret,
    userOpenid: typeof row.userOpenid === 'string' && /^[\w-]+$/.test(row.userOpenid) ? row.userOpenid : null };
}

export function connectByQr(startQrConnect, { signal, timeoutMs = 600000, appId } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop;
    const controller = new AbortController();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      stop?.();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('扫码绑定已取消，凭据未保存'));
    const timer = setTimeout(() => finish(new Error('扫码绑定超时，请重新运行 npm run login')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      stop = startQrConnect({
        onSuccess(rows) {
          if (settled) return;
          try { finish(null, selectCredentials(rows, appId)); }
          catch (error) { finish(error); }
        },
        // Upstream errors may contain responses. Keep diagnostics credential-free.
        onFailure: () => finish(new Error('QQ 扫码连接失败，请检查网络后重试')),
      }, { displayQrCodeToConsole: true, signal: controller.signal });
      if (settled) stop?.();
    } catch { finish(new Error('无法启动 QQ 扫码连接')); }
  });
}

function setEnv(source, key, value) {
  const lines = source.split(/\r?\n/);
  const entry = `${key}=${JSON.stringify(value)}`;
  let found = false;
  const updated = lines.flatMap((line) => {
    if (!new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)) return [line];
    if (found) return [];
    found = true;
    return [entry];
  });
  if (!found) { if (updated.at(-1) === '') updated.pop(); updated.push(entry, ''); }
  return updated.join(source.includes('\r\n') ? '\r\n' : '\n');
}

export async function saveOfficialBinding(envPath, credentials, { templatePath } = {}) {
  const value = selectCredentials([credentials]);
  // dotenv quoted values are not JSON strings; reject characters it cannot round-trip.
  if (/["\\]/.test(value.appSecret)) throw new Error('凭据包含不支持的字符，未保存绑定');
  let source;
  try {
    const info = await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('.env 必须是普通文件');
    source = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = templatePath ? await readFile(templatePath, 'utf8') : '';
  }
  const old = parse(source);
  let updated = source;
  for (const [key, item] of Object.entries({ QQ_TRANSPORT: 'official', QQBOT_APP_ID: value.appId, QQBOT_APP_SECRET: value.appSecret })) {
    updated = setEnv(updated, key, item);
  }
  const newApp = old.QQBOT_APP_ID !== value.appId;
  if (newApp || !old.QQBOT_ALLOWED_USER_IDS?.trim()) {
    updated = setEnv(updated, 'QQBOT_ALLOWED_USER_IDS', value.userOpenid || 'bootstrap-deny-all');
  }
  if (newApp) updated = setEnv(updated, 'QQBOT_ALLOWED_GROUP_IDS', '');
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
    await rename(temporary, envPath);
  } finally { await unlink(temporary).catch(() => {}); }
  return { appId: value.appId, needsAllowlist: parse(updated).QQBOT_ALLOWED_USER_IDS === 'bootstrap-deny-all' };
}

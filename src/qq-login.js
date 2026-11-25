import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

/** Open NapCat's own login page; it owns QR generation, expiry and QQ confirmation. */
export async function openLoginPage(url, { platform = process.platform, run = execFileAsync } = {}) {
  // Windows users can open the printed link; avoid passing URLs through cmd.exe.
  if (platform === 'darwin') return run('open', [url]);
  if (platform === 'linux') return run('xdg-open', [url]);
  throw new Error('请手动打开上面的登录地址');
}

/** Observe authentication only: no chat messages, Claude sessions or database writes. */
export function waitForLogin(client, { signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      client.off('ready', ready);
      signal?.removeEventListener('abort', abort);
      client.disconnect();
    };
    const done = (error, id) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(id);
    };
    const ready = (id) => /^[1-9]\d*$/.test(String(id))
      ? done(null, String(id)) : done(new Error('登录返回了无效 QQ 号，未保存绑定'));
    const abort = () => done(new Error('已取消扫码绑定，未保存绑定'));
    const timer = setTimeout(() => done(new Error('等待登录超时。请检查 NapCat 登录状态、OneBot 服务地址及 token，然后重新运行 npm run login:onebot。')), timeoutMs);
    client.on('ready', ready);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try { client.connect(); } catch { done(new Error('无法启动 OneBot 登录检测')); }
  });
}

export function updateBinding(source, qqId) {
  if (!/^[1-9]\d*$/.test(qqId)) throw new Error('绑定 QQ 号无效');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const result = [];
  let found = false;
  for (const line of lines) {
    if (/^\s*(?:export\s+)?QQ_BOT_ID\s*=/.test(line)) {
      if (!found) result.push(`QQ_BOT_ID=${qqId}`);
      found = true;
    } else result.push(line);
  }
  if (!found) {
    if (result.at(-1) === '') result.pop();
    result.push(`QQ_BOT_ID=${qqId}`, '');
  }
  return result.join(newline);
}

export async function saveBinding(envPath, qqId) {
  const info = await lstat(envPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('.env 必须是普通文件，绑定没有保存');
  // Read at completion so edits made while scanning are retained.
  const source = await readFile(envPath, 'utf8');
  const updated = updateBinding(source, qqId);
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
    await rename(temporary, envPath);
  } finally { await unlink(temporary).catch(() => {}); }
}

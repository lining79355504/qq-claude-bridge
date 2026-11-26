import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isInside } from './guard.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TOOL_NAME = 'mcp__qq__send_file';

export function fileName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || /[\x00-\x1f\x7f/\\]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
    throw new Error('文件名无效或超过 255 字节');
  }
  return name;
}

export function fileBytes(file) {
  fileName(file?.name);
  if (typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)) throw new Error('文件数据无效或超过 10 MiB');
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== file.data) {
    throw new Error('文件必须非空且不超过 10 MiB');
  }
  return bytes;
}

/** Take a bounded snapshot: transports never read arbitrary paths on the bot host. */
export async function readWorkspaceFile(filePath, workspace, allowedPaths) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请填写文件路径');
  const requested = resolve(workspace, filePath);
  const file = await realpath(requested);
  const root = await realpath(workspace);
  const allowed = allowedPaths === '*' ? '*' : await Promise.all(allowedPaths.map((path) => realpath(path)));
  if (!isInside(file, [root]) || !isInside(file, allowed)) throw new Error('文件必须在当前工单工作目录及允许目录范围内');
  const name = fileName(basename(requested));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('只能发送普通文件，目录请先打包为 ZIP');
    if (!info.size || info.size > MAX_FILE_BYTES) throw new Error('文件必须非空且不超过 10 MiB');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size || !size || size > MAX_FILE_BYTES) throw new Error('文件大小发生变化，请生成完毕后重试');
    return { name, data: buffer.subarray(0, size).toString('base64') };
  } finally { await handle.close(); }
}

export function fileReceipt(result) {
  if (result?.status === 'sent') return '文件消息已发送到当前 QQ 聊天。';
  if (result?.status === 'accepted') return 'OneBot 服务已接受文件上传，请在当前 QQ 聊天或群文件中确认。';
  throw new Error('文件接口未返回可识别的发送结果，无法确认送达');
}

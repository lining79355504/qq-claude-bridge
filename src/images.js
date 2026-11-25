import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { isInside } from './guard.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;
const CDN_DOMAINS = ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn', 'gtimg.com'];

export function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片，文件内容与图片格式不符');
}

export function imageFromBytes(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('每张图片必须小于等于 5 MiB，且不能为空');
  return { mediaType: imageType(bytes), data: bytes.toString('base64') };
}

export function imageBytes(image) {
  if (!image || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('图片数据无效或超过 5 MiB');
  const bytes = Buffer.from(image.data, 'base64');
  const verified = imageFromBytes(bytes);
  if (verified.mediaType !== image.mediaType || verified.data !== image.data) throw new Error('图片格式校验失败');
  return bytes;
}

export function imageUrl(value) {
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value); }
  catch { throw new Error('QQ 图片地址无效'); }
  // QQ legacy events can contain http CDN links. Always fetch using TLS.
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !CDN_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('只允许下载 QQ 官方 CDN 图片');
  }
  return url.href;
}

export async function downloadImage(source, { fetchImpl = fetch, signal, timeoutMs = 15000 } = {}) {
  let url = imageUrl(source.url);
  if (Number(source.size) > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB，请压缩后重发');
  const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try { response = await fetchImpl(url, { redirect: 'manual', signal: combined }); }
    catch { throw new Error('QQ 图片下载失败或超时，请重新发送图片'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('QQ 图片跳转地址无效');
      url = imageUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`QQ 图片下载失败（HTTP ${response.status}），请重新发送图片`);
    }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body.cancel();
      throw new Error('图片超过 5 MiB，请压缩后重发');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB，请压缩后重发');
        chunks.push(Buffer.from(result.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (size > MAX_IMAGE_BYTES) throw error;
      throw new Error('QQ 图片下载中断，请重新发送图片');
    } finally { reader.releaseLock(); }
    return imageFromBytes(Buffer.concat(chunks, size));
  }
  throw new Error('QQ 图片地址跳转过多');
}

export async function prepareImages(sources = [], options) {
  if (sources.length > MAX_IMAGES) throw new Error(`每条消息最多 ${MAX_IMAGES} 张图片，请分批发送`);
  const images = [];
  for (const source of sources) images.push(await downloadImage(source, options));
  return images;
}

/** Resolve symlinks before checking both workspace and configured roots. Never upload arbitrary files. */
export async function readWorkspaceImage(filePath, workspace, allowedPaths) {
  const file = await realpath(resolve(workspace, filePath));
  const root = await realpath(workspace);
  const allowed = allowedPaths === '*' ? '*' : await Promise.all(allowedPaths.map((path) => realpath(path)));
  if (!isInside(file, [root]) || !isInside(file, allowed)) throw new Error('图片必须在当前工单工作目录及允许目录范围内');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('发送的图片必须是普通文件');
    if (info.size > MAX_IMAGE_BYTES || info.size === 0) throw new Error('每张图片必须小于等于 5 MiB，且不能为空');
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return imageFromBytes(buffer.subarray(0, size));
  } finally { await handle.close(); }
}

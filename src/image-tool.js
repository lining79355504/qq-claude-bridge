import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readWorkspaceImage } from './images.js';

export const IMAGE_TOOL_NAME = 'mcp__qq__send_image';

export function imageTool({ workspace, getAllowedPaths, getDeniedTools, onImage, getSignal }) {
  return tool('send_image', '将当前工作目录中的一张图片或截图发送到本次任务的 QQ 聊天。支持 PNG/JPEG/GIF/WebP，最多 5 MiB。仅发送已生成的文件；成功回执才代表已发送。', {
    file_path: z.string().min(1).describe('图片绝对路径或相对于当前工作目录的路径'),
  }, async ({ file_path }) => {
    try {
      const signal = getSignal();
      if (!signal || signal.aborted) throw new Error('任务已结束或停止，未发送图片');
      if (getDeniedTools().includes(IMAGE_TOOL_NAME)) throw new Error('图片发送工具已禁用');
      const image = await readWorkspaceImage(file_path, workspace, getAllowedPaths());
      signal.throwIfAborted();
      await onImage(image, { signal });
      return { content: [{ type: 'text', text: '图片已发送到当前 QQ 聊天。' }] };
    } catch (error) {
      // Do not expose filesystem error details, signed URLs or image/base64 data.
      const message = error.code ? '无法读取图片文件，请检查路径和权限' : error.message;
      return { isError: true, content: [{ type: 'text', text: `图片未能确认发送：${message}` }] };
    }
  }, { alwaysLoad: true });
}

export function imageServer(options) {
  return createSdkMcpServer({ name: 'qq', version: '1.0.0', alwaysLoad: true,
    instructions: '当前 QQ 通道支持图片附件。用户要求截图或图片时，调用 send_image 回传已生成的本地图片；不要把保存文件当作已经发图。',
    tools: [imageTool(options)] });
}

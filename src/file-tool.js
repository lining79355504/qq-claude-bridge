import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { FILE_TOOL_NAME, readWorkspaceFile, fileReceipt } from './files.js';

export function fileTool({ workspace, getAllowedPaths, getDeniedTools, onFile, getSignal }) {
  return tool('send_file', '将当前工作目录中已生成的 PDF、Excel、ZIP、代码等普通文件回传到本次任务的 QQ 聊天，保留文件名，最多 10 MiB。官方通道是否支持普通文件取决于平台；失败必须如实说明，不得只给路径就声称已发送。', {
    file_path: z.string().min(1).describe('文件绝对路径或相对于当前工作目录的路径'),
  }, async ({ file_path }) => {
    try {
      const signal = getSignal();
      if (!signal || signal.aborted) throw new Error('任务已结束或停止，未发送文件');
      if (getDeniedTools().includes(FILE_TOOL_NAME)) throw new Error('文件发送工具已禁用');
      const file = await readWorkspaceFile(file_path, workspace, getAllowedPaths());
      signal.throwIfAborted();
      const result = await onFile(file, { signal });
      return { content: [{ type: 'text', text: fileReceipt(result) }] };
    } catch (error) {
      const message = error.code ? '无法读取文件，请检查路径和权限' : error.message;
      return { isError: true, content: [{ type: 'text', text: `文件未能确认发送：${message}` }] };
    }
  }, { alwaysLoad: true });
}

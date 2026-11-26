import { redactSecrets, splitMarkdown } from './schedule-delivery.js';

const MAX_TRACE_BYTES = 24000;
const MAX_ENTRIES = 40;

// Only consume content the SDK explicitly returns. Never request hidden reasoning,
// decode redacted blocks, or include tool arguments/results in the trace.
export function traceEntry(event) {
  let text;
  if (event.kind === 'thinking' && typeof event.text === 'string') {
    text = `模型返回的思考摘要：\n${event.text}`;
  } else if (event.kind === 'tool_use' && typeof event.toolName === 'string') {
    text = `请求调用工具：${event.toolName.slice(0, 200)}（不代表执行成功）`;
  } else return null;
  text = redactSecrets(text);
  for (const key of ['QQBOT_APP_SECRET', 'ONEBOT_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (process.env[key]) text = text.replaceAll(process.env[key], '[凭据已隐藏]');
  }
  const chunks = splitMarkdown(text, 6000);
  return chunks[0] + (chunks.length > 1 ? '\n（本条摘要已截断）' : '');
}

export function appendTrace(trace, text) {
  trace.entries.push(text);
  while (trace.entries.length > MAX_ENTRIES
    || Buffer.byteLength(trace.entries.join('\n\n'), 'utf8') > MAX_TRACE_BYTES) {
    trace.entries.shift();
    trace.dropped++;
  }
}

export function renderTrace(ticketId, trace, page = 1, maxBytes = 3800) {
  const content = [
    trace.dropped ? `（较早的 ${trace.dropped} 条记录已省略）` : '',
    ...trace.entries,
  ].filter(Boolean).join('\n\n') || '尚无可展示的摘要。模型可能未返回思考摘要，或本轮尚未调用工具。';
  // Leave room for the heading and navigation, keeping each requested page to a
  // single QQ message even when the configured message budget is small.
  const pages = splitMarkdown(content, Math.max(64, Math.min(maxBytes, 3800) - 180));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) {
    throw new Error(`页码超出范围，共 ${pages.length} 页。`);
  }
  return `工单 #${ticketId} · 执行摘要 ${page}/${pages.length}\n\n${pages[page - 1]}`
    + (page < pages.length ? `\n\n下一页：/verbose show ${ticketId} ${page + 1}` : '');
}

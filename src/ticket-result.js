import { redactSecrets, splitMarkdown } from './schedule-delivery.js';

// A single page must fit one passive reply, including its navigation. The
// message ID pins subsequent pages even if another task finishes meanwhile.
export function renderResult(ticketId, message, page = 1, maxBytes = 3800) {
  const limit = Math.min(maxBytes, 3800);
  const pages = splitMarkdown(redactSecrets(message.content), limit - 220);
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) {
    throw new Error(`页码超出范围，共 ${pages.length} 页。`);
  }
  return `工单 #${ticketId} · 已保存回复 ${message.id} · ${page}/${pages.length}\n\n${pages[page - 1]}`
    + (page < pages.length ? `\n\n下一页：/result ${ticketId} ${page + 1} ${message.id}` : '');
}

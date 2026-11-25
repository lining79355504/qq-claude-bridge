// OneBot text is decoded only after CQ segments have been recognized.
const unescapeCQ = (text) => text.replace(/&#91;/g, '[').replace(/&#93;/g, ']')
  .replace(/&#44;/g, ',').replace(/&amp;/g, '&');
const idOf = (value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value))
  || (Number.isSafeInteger(value) && value > 0) ? String(value) : null;

export function segmentsOf(message) {
  if (Array.isArray(message)) return message.filter((s) => s && typeof s.type === 'string' && s.data && typeof s.data === 'object');
  if (typeof message !== 'string') return [];
  const segments = [];
  let offset = 0;
  for (const match of message.matchAll(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset) segments.push({ type: 'text', data: { text: unescapeCQ(message.slice(offset, match.index)) } });
    const data = Object.fromEntries(match[2].split(',').filter(Boolean).map((entry) => {
      const at = entry.indexOf('=');
      return [entry.slice(0, at), unescapeCQ(entry.slice(at + 1))];
    }));
    segments.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  if (offset < message.length) segments.push({ type: 'text', data: { text: unescapeCQ(message.slice(offset)) } });
  return segments;
}

export function normalizeMessage(event, config, selfId) {
  if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  const userId = idOf(event.user_id);
  if (!userId || userId === String(selfId) || !config.allowedUserIds.includes(userId)) return null;
  const segments = segmentsOf(event.message);
  let target;
  if (event.message_type === 'group') {
    const groupId = idOf(event.group_id);
    if (!groupId || !config.allowedGroupIds.includes(groupId)) return null;
    if (config.groupRequireAt && !segments.some((s) => s.type === 'at' && String(s.data?.qq) === String(selfId))) return null;
    target = `group:${groupId}`;
  } else {
    // Temporary group sessions require additional routing metadata; accept friends only.
    if (event.sub_type !== 'friend') return null;
    target = `user:${userId}`;
  }
  const text = segments.filter((s) => s.type === 'text').map((s) => String(s.data?.text ?? '')).join('').trim();
  const imageSources = segments.filter((s) => s.type === 'image').map((s) => ({ url: s.data?.url ?? s.data?.file }));
  if (!text && !imageSources.length) return null;
  return { chatKey: target, userId, text: text || '请分析这些图片。', imageSources, frame: { target },
    messageId: event.message_id == null ? null : `${target}:${event.message_id}` };
}

export class MessageDeduper {
  constructor({ ttlMs = 10 * 60 * 1000, maxSize = 10000 } = {}) {
    Object.assign(this, { ttlMs, maxSize });
    this.seen = new Map();
  }
  accept(key, now = Date.now()) {
    if (!key) return false;
    for (const [id, expiry] of this.seen) {
      if (expiry > now) break;
      this.seen.delete(id);
    }
    if (this.seen.has(key)) return false;
    while (this.seen.size >= this.maxSize) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

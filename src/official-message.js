const validId = (value) => typeof value === 'string' && /^[\w-]+$/.test(value);

/** Official IDs are scoped to the app; never mix them with OneBot QQ numbers. */
export function normalizeOfficialMessage(event, config, { now = Date.now(), onDenied } = {}) {
  if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(event?.t)) return null;
  const data = event.d;
  const group = event.t === 'GROUP_AT_MESSAGE_CREATE';
  const userId = group ? data?.author?.member_openid : data?.author?.user_openid;
  const groupId = data?.group_openid;
  const messageId = data?.id;
  if (!validId(userId) || typeof messageId !== 'string' || !messageId || messageId.length > 1024
    || /[\x00-\x1f]/.test(messageId) || (group && !validId(groupId))) return null;
  if (!config.allowedUserIds.includes(userId) || (group && !config.allowedGroupIds.includes(groupId))) {
    onDenied?.({ userId, groupId: group ? groupId : null });
    return null;
  }
  const text = typeof data.content === 'string' ? data.content.replace(/^\s*<@!?\w+>\s*/, '').trim() : '';
  const imageSources = (Array.isArray(data.attachments) ? data.attachments : [])
    .filter((a) => a && ((typeof a.content_type === 'string' && a.content_type.startsWith('image/')) || /\.(?:png|jpe?g|gif|webp)$/i.test(a.filename ?? '')))
    .map((a) => ({ url: a.url, size: a.size }));
  if (!text && !imageSources.length) return null;
  const timestamp = Date.parse(data.timestamp);
  // A replayed message must not gain a new reply window just because it arrived now.
  const createdAt = Number.isFinite(timestamp) ? Math.min(timestamp, now) : now;
  const target = `qqbot:${config.appId}:${group ? 'group' : 'user'}:${group ? groupId : userId}`;
  return { chatKey: target, userId, text: text || '请分析这些图片。', imageSources, messageId: `${target}:${data.id}`,
    frame: { target, reply: { id: data.id, createdAt } } };
}

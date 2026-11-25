const API_ORIGIN = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** Errors omit request/response bodies: they may contain credentials or user text. */
export class OfficialApi {
  constructor({ appId, appSecret, fetchImpl = fetch, timeoutMs = 10000, now = Date.now }) {
    Object.assign(this, { appId, appSecret, fetchImpl, timeoutMs, now });
    this.token = null;
    this.expiresAt = 0;
    this.refresh = null;
  }
  async json(url, options, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try { response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: combined }); }
    catch { throw new Error('QQ API 网络请求失败或超时'); }
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`QQ API HTTP ${response.status}，响应不是 JSON`); }
    if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
      const error = new Error(`QQ API HTTP ${response.status}${typeof body?.code === 'number' ? `，code=${body.code}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
  async accessToken(signal) {
    if (this.token && this.expiresAt > this.now()) return this.token;
    if (!this.refresh) {
      this.refresh = (async () => {
        const body = await this.json(TOKEN_URL, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        }, signal);
        const lifetime = Number(body?.expires_in);
        if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
          throw new Error('QQ API 未返回有效 access_token');
        }
        this.token = body.access_token;
        this.expiresAt = this.now() + Math.max(1, lifetime - Math.min(60, lifetime / 10)) * 1000;
        return this.token;
      })().finally(() => { this.refresh = null; });
    }
    return this.refresh;
  }
  async request(path, { body, signal } = {}) {
    const token = await this.accessToken(signal);
    try {
      return await this.json(`${API_ORIGIN}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': this.appId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, signal);
    } catch (error) {
      if (error.status === 401 && this.token === token) { this.token = null; this.expiresAt = 0; }
      // Do not automatically replay message POSTs: a lost receipt may still be delivered.
      throw error;
    }
  }
  async gateway(signal) {
    const body = await this.request('/gateway', { signal });
    let url;
    try { url = new URL(body?.url); } catch { throw new Error('QQ gateway 地址无效'); }
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.qq.com') || url.username || url.password) {
      throw new Error('QQ gateway 必须是 qq.com 下的安全 WebSocket 地址');
    }
    return url.href;
  }
}

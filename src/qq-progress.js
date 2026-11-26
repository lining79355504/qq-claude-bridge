export class QQProgress {
  constructor({ send, ticketId, intervalMs = 15000, logger, now = Date.now }) {
    Object.assign(this, { send, ticketId, intervalMs, logger, now });
    this.lastSentAt = -Infinity;
    this.lines = [];
    this.closed = false;
    this.pending = Promise.resolve();
  }
  push(line) {
    if (this.closed) return Promise.resolve();
    if (line) this.lines.push(line);
    this.lines = this.lines.slice(-5);
    if (this.now() - this.lastSentAt < this.intervalMs) return Promise.resolve();
    this.lastSentAt = this.now();
    const text = `⏳ 工单 #${this.ticketId} 执行中\n${this.lines.join('\n')}`;
    this.lines = [];
    this.pending = this.pending.then(() => this.send(text)).catch((error) => this.logger.warn('进度发送失败', error.message));
    return this.pending;
  }
  async finish(text) {
    if (this.closed) return;
    this.closed = true;
    await this.pending;
    // Execution results are already saved. Delivery failure must not mark the task failed.
    try { await this.send(text); }
    catch (error) { this.logger.error(`工单 #${this.ticketId} 结果发送失败，已保存；请在原聊天发送 /result ${this.ticketId} 分页取回全文（不会重新执行）`, error.message); }
  }
}

// Strict, non-wrapping sequence ordering. Constructor identifies the last
// delivered sequence (0 for a newly allocated v2 stream). No restart/salvage.
const ORDER_STATUS = Object.freeze({ DELIVER: 'deliver', BUFFERED: 'buffered', DUPLICATE: 'duplicate', FAILED: 'failed' });
class OrderedDedupWindow {
  constructor(lastSeqNo = 0, options = {}) {
    this.expected = lastSeqNo + 1;
    this.buffer = new Map();
    this.bytes = 0;
    this.maxBuffer = options.maxBuffer || 512;
    this.maxGap = options.maxGap || 4096;
    this.maxBytes = options.maxBytes || 4 * 1024 * 1024;
    this.gapTimeoutMs = options.gapTimeoutMs || 1000;
    this.onGapTimeout = options.onGapTimeout;
    this.reserve = options.reserve || (() => true);
    this.release = options.release || (() => {});
    this.failed = false;
    this.failReason = null;
    this.gapTimer = null;
  }
  accept(seq, item) {
    if (this.failed) return ORDER_STATUS.FAILED;
    if (!Number.isInteger(seq) || seq < 1 || seq > 0xffffff0f) return this._fail('sequence-boundary');
    if (seq < this.expected || this.buffer.has(seq)) return ORDER_STATUS.DUPLICATE;
    if (seq === this.expected) { this.expected++; return ORDER_STATUS.DELIVER; }
    const size = (item?.payload?.length || 0) + 13;
    if (seq - this.expected > this.maxGap || this.buffer.size >= this.maxBuffer || this.bytes + size > this.maxBytes || !this.reserve(size)) {
      return this._fail('overflow');
    }
    this.bytes += size;
    this.buffer.set(seq, { item, size });
    if (!this.gapTimer) {
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        if (!this.buffer.size || this.failed) return;
        this._fail('timeout');
        this.onGapTimeout?.(this);
      }, this.gapTimeoutMs);
      this.gapTimer.unref?.();
    }
    return ORDER_STATUS.BUFFERED;
  }
  takeNext() {
    if (this.failed) return null;
    const entry = this.buffer.get(this.expected);
    if (!entry) { if (!this.buffer.size) this._clearTimer(); return null; }
    this.buffer.delete(this.expected++);
    this.bytes -= entry.size;
    this.release(entry.size);
    if (!this.buffer.size) this._clearTimer();
    return entry.item;
  }
  drain() { const out = []; let item; while ((item = this.takeNext())) out.push(item); return out; }
  get bufferedCount() { return this.buffer.size; }
  fail(reason) { if (this.failed) return false; this._fail(reason); return true; }
  _fail(reason) { this.failed = true; this.failReason = reason; this.dispose(); return ORDER_STATUS.FAILED; }
  _clearTimer() { clearTimeout(this.gapTimer); this.gapTimer = null; }
  dispose() {
    this._clearTimer();
    for (const { size } of this.buffer.values()) this.release(size);
    this.buffer.clear(); this.bytes = 0;
  }
}
module.exports = { OrderedDedupWindow, ORDER_STATUS };

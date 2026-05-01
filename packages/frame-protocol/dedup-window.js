// DedupWindow — Sliding window for sequence number deduplication
// Uses Uint8Array bitmask (128 bits) for fast bitwise ops in V8 hot path

class DedupWindow {
  constructor(firstSeqNo) {
    this.base = firstSeqNo >>> 0;
    this.windowSize = 128;
    this.bytes = 16; // 128 bits / 8
    this.bits = new Uint8Array(this.bytes);
  }

  // Calculate offset from base (unsigned 32-bit wraps correctly)
  _offset(seqNo) {
    return (seqNo - this.base) >>> 0;
  }

  // Set bit at given offset
  _set(offset) {
    this.bits[offset >>> 3] |= 1 << (offset & 7);
  }

  // Check if bit at given offset is set
  _isSet(offset) {
    return !!(this.bits[offset >>> 3] & (1 << (offset & 7)));
  }

  // Shift entire bitset left by n positions
  _shiftLeft(n) {
    if (n === 0) return;
    if (n >= this.windowSize) {
      this.bits.fill(0);
      return;
    }

    const byteShift = n >>> 3;
    const bitShift = n & 7;

    // Byte-level shift
    if (byteShift > 0) {
      this.bits.copyWithin(0, byteShift);
      this.bits.fill(0, this.bytes - byteShift);
    }

    // Bit-level shift
    if (bitShift > 0) {
      for (let i = 0; i < this.bytes - 1; i++) {
        this.bits[i] = ((this.bits[i] >>> bitShift) | (this.bits[i + 1] << (8 - bitShift))) & 0xFF;
      }
      this.bits[this.bytes - 1] >>>= bitShift;
    }
  }

  /**
   * Check if seqNo is a duplicate, and mark it if not.
   * @param {number} seqNo - 32-bit unsigned sequence number
   * @returns {'new' | 'duplicate'}
   */
  checkAndAdd(seqNo) {
    seqNo = seqNo >>> 0;
    let offset = this._offset(seqNo);

    // If seqNo is far behind base (wrapped around in unsigned),
    // the offset will be > half the 32-bit space. Treat as too old.
    if (offset > 0x80000000) {
      return 'duplicate';
    }

    if (offset >= this.windowSize) {
      // SeqNo jumped far ahead — advance window
      const shift = offset - this.windowSize + 1;
      this.base = (this.base + shift) >>> 0;
      this._shiftLeft(shift);
      offset = this._offset(seqNo);
    }

    if (this._isSet(offset)) {
      return 'duplicate';
    }

    this._set(offset);
    return 'new';
  }

  /**
   * Garbage collect: advance base past fully-processed bytes.
   * Skips fully-zero bytes AND fully-set bytes (all 8 seqNos processed).
   */
  compact() {
    // Skip leading zero bytes
    let byteIdx = 0;
    while (byteIdx < this.bytes && this.bits[byteIdx] === 0) {
      byteIdx++;
    }
    if (byteIdx > 0) {
      this.bits.copyWithin(0, byteIdx);
      this.bits.fill(0, this.bytes - byteIdx);
      this.base = (this.base + byteIdx * 8) >>> 0;
    }

    // Skip fully-set bytes (all 8 consecutive seqNos delivered)
    byteIdx = 0;
    while (byteIdx < this.bytes && this.bits[byteIdx] === 0xFF) {
      byteIdx++;
    }
    if (byteIdx > 0) {
      this.bits.copyWithin(0, byteIdx);
      this.bits.fill(0, this.bytes - byteIdx);
      this.base = (this.base + byteIdx * 8) >>> 0;
    }
  }
}

module.exports = { DedupWindow };

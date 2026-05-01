// ConnectionPool — Server-side multipath connection manager
// Accepts multiple TLS connections from the same client, dedups inbound, broadcasts outbound

const { encodeFrame, FrameType, CONTROL_FRAME_TYPES, DedupWindow } = require('../../../packages/frame-protocol');

const SEQ_RESET_THRESHOLD = 0xFFFFFF0F; // 2^32 - 1,000,000

class ConnectionPool {
  constructor() {
    this.connections = new Map(); // interfaceName -> socket
    this.dedupWindows = new Map(); // streamId -> DedupWindow
    this.seqCounters = new Map(); // streamId -> nextSeqNo
    this.activeStreams = new Map(); // streamId -> { frameHandler, errorHandler }
  }

  /**
   * Register a new connection. Replaces existing one with same interface name.
   */
  add(interfaceName, socket) {
    // Replace existing connection for this interface
    if (this.connections.has(interfaceName)) {
      const old = this.connections.get(interfaceName);
      try { old.destroy(); } catch {}
    }
    this.connections.set(interfaceName, socket);
  }

  /**
   * Remove a connection
   */
  remove(socket) {
    for (const [name, s] of this.connections) {
      if (s === socket) {
        this.connections.delete(name);
        break;
      }
    }
    // If no connections left, clean up all streams
    if (this.connections.size === 0) {
      this._cleanupAllStreams();
    }
  }

  get count() {
    return this.connections.size;
  }

  /**
   * Process an incoming data frame from any connection.
   * Handles dedup and routes to stream handlers.
   * @returns {'new' | 'duplicate'}
   */
  onFrame(frame) {
    // Control frames are handled per-connection, skip
    if (frame.streamId === 0 && CONTROL_FRAME_TYPES.has(frame.type)) {
      return 'new';
    }

    const streamId = frame.streamId;

    // Stream lifecycle — FIN/ERROR: dedup before delivery
    if (frame.type === FrameType.FIN || frame.type === FrameType.ERROR) {
      let window = this.dedupWindows.get(streamId);
      if (!window) {
        window = new DedupWindow(frame.seqNo);
        window.checkAndAdd(frame.seqNo);
        this.dedupWindows.set(streamId, window);
      } else {
        const result = window.checkAndAdd(frame.seqNo);
        if (result === 'duplicate') return 'duplicate';
      }
      // Only clean seqCounters — keep dedupWindow for late duplicates
      this.seqCounters.delete(streamId);
      this._routeToHandler(frame);
      return 'new';
    }

    // HEADERS — dedup if window already exists
    if (frame.type === FrameType.HEADERS) {
      let window = this.dedupWindows.get(streamId);
      if (!window) {
        window = new DedupWindow(frame.seqNo);
        this.dedupWindows.set(streamId, window);
      }
      if (window.checkAndAdd(frame.seqNo) === 'duplicate') return 'duplicate';
      this._routeToHandler(frame);
      return 'new';
    }

    // DATA frames — dedup check
    let window = this.dedupWindows.get(streamId);
    if (!window) {
      window = new DedupWindow(frame.seqNo);
      window.checkAndAdd(frame.seqNo);
      this.dedupWindows.set(streamId, window);
      this._routeToHandler(frame);
      return 'new';
    }

    const result = window.checkAndAdd(frame.seqNo);
    if (result === 'duplicate') return 'duplicate';

    this._routeToHandler(frame);
    return 'new';
  }

  _routeToHandler(frame) {
    const handler = this.activeStreams.get(frame.streamId);
    if (!handler) return;

    if (frame.type === FrameType.ERROR && handler.errorHandler) {
      handler.errorHandler(new Error(frame.payload.toString()));
    } else if (handler.frameHandler) {
      handler.frameHandler(frame);
    }
  }

  /**
   * Send a frame to the client — assigns seqNo and duplicates to all connections.
   */
  send(frameBuf) {
    const type = frameBuf.readUInt8(4);

    if (!CONTROL_FRAME_TYPES.has(type)) {
      const streamId = frameBuf.readUInt32BE(0);
      let seqNo = (this.seqCounters.get(streamId) || 0) + 1;

      if (seqNo > SEQ_RESET_THRESHOLD) {
        this._sendResetSeq(streamId);
        seqNo = 0;
      }

      this.seqCounters.set(streamId, seqNo);
      frameBuf.writeUInt32BE(seqNo, 5);
    }

    for (const [name, sock] of this.connections) {
      if (!sock.destroyed) {
        sock.write(frameBuf);
      }
    }
  }

  _sendResetSeq(streamId) {
    const frame = encodeFrame(0, FrameType.RESET_SEQ, JSON.stringify({
      streams: [streamId]
    }), 0);

    for (const [name, sock] of this.connections) {
      if (!sock.destroyed) {
        sock.write(frame);
      }
    }

    this.seqCounters.set(streamId, 0);
  }

  /**
   * Handle an incoming RESET_SEQ from the client.
   * Clears only dedup windows (incoming) — not outbound seqCounters.
   */
  handleResetSeq(frame) {
    try {
      const data = JSON.parse(frame.payload.toString());
      for (const streamId of data.streams) {
        this.dedupWindows.delete(streamId);
        // Do NOT reset seqCounters — RESET_SEQ from client means
        // "I reset my outbound", so we only clear our incoming dedup.
      }
    } catch {}
  }

  registerStream(streamId, handlers) {
    this.activeStreams.set(streamId, handlers);
  }

  unregisterStream(streamId) {
    this.activeStreams.delete(streamId);
  }

  getStreamHandler(streamId) {
    return this.activeStreams.get(streamId) || null;
  }

  _cleanupAllStreams() {
    for (const [streamId, handlers] of this.activeStreams) {
      if (handlers.errorHandler) {
        handlers.errorHandler(new Error('Client disconnected'));
      }
    }
    this.activeStreams.clear();
    this.dedupWindows.clear();
    this.seqCounters.clear();
  }
}

module.exports = { ConnectionPool, SEQ_RESET_THRESHOLD };

// Client Manager - Tracks a single connected tunnel client

class ClientManager {
  constructor() {
    this.client = null; // Single client connection
  }

  add(clientInfo) {
    // Disconnect existing client if any (only one allowed)
    if (this.client) {
      this.client.socket.destroy();
    }
    this.client = clientInfo;
  }

  get() {
    return this.client;
  }

  remove() {
    if (this.client) {
      // Clean up all active streams
      if (this.client.activeStreams) {
        for (const [streamId, handlers] of this.client.activeStreams) {
          if (handlers.errorHandler) {
            handlers.errorHandler(new Error('Client disconnected'));
          }
        }
        this.client.activeStreams.clear();
      }
      this.client = null;
    }
  }

  has() {
    return this.client !== null;
  }

  registerStream(streamId, handlers) {
    if (!this.client) return;
    if (!this.client.activeStreams) {
      this.client.activeStreams = new Map();
    }
    this.client.activeStreams.set(streamId, handlers);
  }

  unregisterStream(streamId) {
    if (this.client && this.client.activeStreams) {
      this.client.activeStreams.delete(streamId);
    }
  }

  getStreamHandler(streamId) {
    if (this.client && this.client.activeStreams) {
      return this.client.activeStreams.get(streamId);
    }
    return null;
  }
}

module.exports = { ClientManager };

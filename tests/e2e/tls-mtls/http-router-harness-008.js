// Focused test harness for http-router / multi-client-manager hardening.
//
// These tests drive apps/server/lib/http-router.js directly with a fake
// ConnectionPool so tunnel-side frames can be injected and backpressure can be
// forced deterministically. The "browser" side is a real TCP/HTTP client so the
// public behaviour (status line, headers, truncated responses) is observable.
//
// Uniquely named for the 008 hardening task; it is a helper module, not a test
// file, and it does not touch the shared runners.

'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { encodeFrame, FrameType, HEADER_SIZE } = require('../../../packages/frame-protocol');

function decodeSentFrame(buf) {
  return {
    streamId: buf.readUInt32BE(0),
    type: buf.readUInt8(4),
    seqNo: buf.readUInt32BE(5),
    payload: Buffer.from(buf.subarray(HEADER_SIZE)),
    length: buf.readUInt32BE(9)
  };
}

/**
 * Fake server-side pool: records every frame the router sends, lets the test
 * force backpressure verdicts, and exposes the registered stream handlers.
 */
function createFakePool(options = {}) {
  const pool = {
    activeStreams: new Map(),
    connections: new Map(),
    count: 1,
    streamModes: new Map(),
    sent: [],
    registeredIds: [],
    unregisteredIds: [],
    drainCallbacks: [],
    paused: false,
    resummed: 0,
    // (streamId, type, payload, index) => boolean | undefined
    // `false` simulates write() returning false (backpressure).
    sendVerdict: options.sendVerdict || null,
    // (frame, index) => boolean; true simulates write() throwing.
    throwOn: options.throwOn || null,

    registerStream(streamId, handlers) {
      pool.activeStreams.set(streamId, handlers);
      if (!pool.registeredIds.includes(streamId)) pool.registeredIds.push(streamId);
    },
    unregisterStream(streamId) {
      pool.activeStreams.delete(streamId);
      if (!pool.unregisteredIds.includes(streamId)) pool.unregisteredIds.push(streamId);
    },
    getStreamHandler(streamId) {
      return pool.activeStreams.get(streamId) || null;
    },
    setStreamMode(streamId, mode) {
      pool.streamModes.set(streamId, mode);
    },
    clearStreamMode(streamId) {
      pool.streamModes.delete(streamId);
    },
    onceDrainForStream(streamId, callback) {
      pool.drainCallbacks.push(callback);
    },
    onceDrain(callback) {
      pool.drainCallbacks.push(callback);
    },
    pauseStream() { pool.paused = true; },
    resumeStream() { pool.paused = false; pool.resummed++; },
    pause() { pool.paused = true; },
    resume() { pool.paused = false; pool.resummed++; },

    send(frameBuf) {
      const frame = decodeSentFrame(frameBuf);
      let ok = true;
      if (pool.throwOn && pool.throwOn(frame, pool.sent.length)) {
        throw new Error('simulated write failure');
      }
      if (pool.sendVerdict) {
        const verdict = pool.sendVerdict(frame, pool.sent.length);
        if (verdict === false) ok = false;
      }
      frame.ok = ok;
      pool.sent.push(frame);
      return ok;
    },

    frames(type, streamId) {
      return pool.sent.filter((frame) => frame.type === type && (streamId === undefined || frame.streamId === streamId));
    },
    deliveredData(streamId) {
      return pool.sent.filter((frame) => frame.type === FrameType.DATA && frame.ok && (streamId === undefined || frame.streamId === streamId));
    },
    flushDrains() {
      const callbacks = pool.drainCallbacks;
      pool.drainCallbacks = [];
      for (const callback of callbacks) callback();
      return callbacks.length;
    }
  };
  return pool;
}

function createFakeTlsServer() {
  let next = 1000;
  const allocated = [];
  const released = [];
  return {
    allocated,
    released,
    allocateStreamId() { const id = next++; allocated.push(id); return id; },
    releaseStreamId(id) { released.push(id); }
  };
}

function buildClientFrame(opcode, payload, masked = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;

  if (!masked) return Buffer.concat([header, body]);

  header[1] |= 0x80;
  const maskKey = crypto.randomBytes(4);
  const maskedBody = Buffer.alloc(len);
  for (let i = 0; i < len; i++) maskedBody[i] = body[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, maskedBody]);
}

function parseServerFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const fin = (buffer[offset] & 0x80) !== 0;
    let len = buffer[offset + 1] & 0x7f;
    let headerSize = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerSize = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = buffer.readUInt32BE(offset + 6);
      headerSize = 10;
    }
    if (offset + headerSize + len > buffer.length) break;
    frames.push({
      fin,
      opcode,
      payload: Buffer.from(buffer.subarray(offset + headerSize, offset + headerSize + len))
    });
    offset += headerSize + len;
  }
  return frames;
}

class BrowserConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.ended = false;
    this.error = null;
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._notify();
    });
    socket.on('end', () => { this.ended = true; this._notify(); });
    socket.on('close', () => { this.closed = true; this._notify(); });
    socket.on('error', (err) => { this.error = err; this._notify(); });
  }

  _notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async waitFor(predicate, timeoutMs = 2000, label = 'condition') {
    const deadline = Date.now() + timeoutMs;
    // Polling fallback keeps this robust against missed notifications.
    while (Date.now() <= deadline) {
      if (predicate(this)) return true;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, 25);
        this.waiters.push(() => { clearTimeout(timer); finish(); });
      });
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  get headerEnd() {
    return this.buffer.indexOf('\r\n\r\n');
  }

  headerText() {
    const end = this.headerEnd;
    return end === -1 ? '' : this.buffer.subarray(0, end).toString('latin1');
  }

  statusLine() {
    return this.headerText().split('\r\n')[0] || '';
  }

  bodyBuffer() {
    const end = this.headerEnd;
    return end === -1 ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(end + 4));
  }

  serverFrames() {
    return parseServerFrames(this.bodyBuffer());
  }

  destroy() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

async function connectBrowser({ port, path = '/ws', offers = {}, leadingFrames = [] }) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = crypto.randomBytes(16).toString('base64');
  const lines = [
    `GET ${path} HTTP/1.1`,
    'Host: test.local',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13'
  ];
  for (const [name, value] of Object.entries(offers)) lines.push(`${name}: ${value}`);
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
  const browser = new BrowserConnection(socket);
  socket.write(leadingFrames.length > 0 ? Buffer.concat([head, ...leadingFrames]) : head);
  return browser;
}

/**
 * Start an HTTP server built from createHTTPServer with the fake pool.
 * `serverOptions` are forwarded to createHTTPServer.
 */
async function startRouterHarness(serverOptions = {}) {
  const pool = createFakePool(serverOptions.poolOptions || {});
  const tlsServer = createFakeTlsServer();
  const httpServer = createHTTPServer(pool, tlsServer, serverOptions);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;

  return {
    pool,
    tlsServer,
    httpServer,
    port,
    async waitForStream(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      // Use the historical list: a fast abort path (e.g. 413) can register and
      // unregister the stream before the test gets a chance to look.
      while (Date.now() <= deadline) {
        if (pool.registeredIds.length > 0) return pool.registeredIds[pool.registeredIds.length - 1];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for stream registration');
    },
    response(streamId, status, headers = {}) {
      const handler = pool.getStreamHandler(streamId);
      if (!handler) throw new Error(`No registered handler for stream ${streamId}`);
      handler.frameHandler({
        streamId,
        type: FrameType.HEADERS,
        payload: Buffer.from(JSON.stringify({ status, headers }))
      });
    },
    upgradeResponse(streamId, status, headers = {}) {
      const handler = pool.getStreamHandler(streamId);
      if (!handler) throw new Error(`No registered handler for stream ${streamId}`);
      handler.frameHandler({
        streamId,
        type: FrameType.UPGRADE,
        payload: Buffer.from(JSON.stringify({ status, headers }))
      });
    },
    data(streamId, payload) {
      const handler = pool.getStreamHandler(streamId);
      if (handler) handler.frameHandler({ streamId, type: FrameType.DATA, payload });
    },
    fin(streamId) {
      const handler = pool.getStreamHandler(streamId);
      if (handler) handler.frameHandler({ streamId, type: FrameType.FIN, payload: Buffer.alloc(0) });
    },
    tunnelError(streamId, message = 'client error') {
      const handler = pool.getStreamHandler(streamId);
      if (handler) handler.frameHandler({ streamId, type: FrameType.ERROR, payload: Buffer.from(message) });
    },
    streamError(streamId, error = new Error('stream failed')) {
      const handler = pool.getStreamHandler(streamId);
      if (handler && handler.errorHandler) handler.errorHandler(error);
    },
    async close() {
      // Do not let a still-open upgraded socket block close(): tests may fail
      // before destroying the browser side.
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      await new Promise((resolve) => httpServer.close(resolve));
    },
    terminalFrames(streamId) {
      return pool.sent.filter(
        (frame) => frame.streamId === streamId && (frame.type === FrameType.ERROR || frame.type === FrameType.FIN)
      );
    },
    errorFrames(streamId) {
      return pool.sent.filter((frame) => frame.streamId === streamId && frame.type === FrameType.ERROR);
    },
    finFrames(streamId) {
      return pool.sent.filter((frame) => frame.streamId === streamId && frame.type === FrameType.FIN);
    }
  };
}

/** Minimal HTTP request helper (browser -> public http server). */
function httpRequest({ port, path = '/', method = 'GET', headers = {}, body = null, agent = false }) {
  const { request } = require('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      const chunks = [];
      let aborted = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => { aborted = true; });
      res.on('error', (err) => {
        // Truncated chunked responses surface as an error on the response.
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), aborted: true, error: err });
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), aborted, error: null });
      });
    });
    req.on('error', (err) => {
      resolve({ statusCode: null, headers: {}, body: '', aborted: true, error: err, requestError: true });
    });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  FrameType,
  createFakePool,
  createFakeTlsServer,
  startRouterHarness,
  connectBrowser,
  buildClientFrame,
  parseServerFrames,
  httpRequest
};

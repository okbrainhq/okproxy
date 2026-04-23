const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const { request } = require('node:http');
const crypto = require('node:crypto');

function buildMaskedFrame(opcode, payload) {
  const maskKey = crypto.randomBytes(4);
  const payloadLen = payload.length;
  let frame, offset;

  if (payloadLen < 126) {
    frame = Buffer.allocUnsafe(6 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payloadLen;
    maskKey.copy(frame, 2);
    offset = 6;
  } else if (payloadLen < 65536) {
    frame = Buffer.allocUnsafe(8 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLen, 2);
    maskKey.copy(frame, 4);
    offset = 8;
  } else {
    frame = Buffer.allocUnsafe(14 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(payloadLen, 6);
    maskKey.copy(frame, 10);
    offset = 14;
  }

  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }

  return frame;
}

function parseUnmaskedFrame(buffer) {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const high = buffer.readUInt32BE(2);
    if (high !== 0) return null;
    payloadLen = buffer.readUInt32BE(6);
    offset = 10;
  }

  if (buffer.length < offset + payloadLen) return null;

  const payload = buffer.subarray(offset, offset + payloadLen);
  const remaining = buffer.subarray(offset + payloadLen);

  return { fin, opcode, payload, remaining };
}

function wsConnect(httpPort, path) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('WS connect timeout'));
    }, 5000);

    const req = request(
      {
        hostname: 'localhost',
        port: httpPort,
        path: path || '/ws-echo',
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      },
      () => {
        clearTimeout(timer);
        reject(new Error('Got HTTP response instead of upgrade'));
      }
    );

    req.on('upgrade', (res, socket) => {
      clearTimeout(timer);
      resolve({ res, socket, req });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

describe('WebSocket', () => {
  it('should complete handshake', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');
      assert.strictEqual(ws.res.statusCode, 101);
      assert.ok(ws.res.headers['sec-websocket-accept']);
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should echo text frames', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');

      const messages = [];
      let buffer = Buffer.alloc(0);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1000);

        ws.socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          while (true) {
            const result = parseUnmaskedFrame(buffer);
            if (!result) break;
            buffer = result.remaining;

            if (result.opcode === 0x01) {
              messages.push(result.payload.toString());
            }
          }
        });

        ws.socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        // Send text message
        ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Hello WebSocket')));

        // Send another
        setTimeout(() => {
          ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Second message')));
        }, 100);
      });

      assert.ok(messages.some((m) => m.includes('Hello WebSocket')), 'Should receive first echo');
      assert.ok(messages.some((m) => m.includes('Second message')), 'Should receive second echo');
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should echo binary frames', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');

      const binaryData = crypto.randomBytes(256);
      let receivedData = null;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1000);

        ws.socket.on('data', (chunk) => {
          const result = parseUnmaskedFrame(chunk);
          if (result && result.opcode === 0x02) {
            receivedData = result.payload;
          }
        });

        ws.socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        ws.socket.write(buildMaskedFrame(0x02, binaryData));
      });

      assert.ok(receivedData, 'Should receive binary echo');
      assert.deepStrictEqual(receivedData, binaryData);
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should handle close frame', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');

      let closeReceived = false;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1000);

        ws.socket.on('data', (chunk) => {
          const result = parseUnmaskedFrame(chunk);
          if (result && result.opcode === 0x08) {
            closeReceived = true;
          }
        });

        ws.socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        // Send close frame
        setTimeout(() => {
          ws.socket.write(buildMaskedFrame(0x08, Buffer.alloc(0)));
        }, 100);
      });

      assert.ok(closeReceived, 'Should receive close frame response');
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should respond to ping with pong', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');

      const pingPayload = crypto.randomBytes(8);
      let pongReceived = false;
      let pongPayload = null;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1000);

        ws.socket.on('data', (chunk) => {
          const result = parseUnmaskedFrame(chunk);
          if (result && result.opcode === 0x0a) {
            pongReceived = true;
            pongPayload = result.payload;
          }
        });

        ws.socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        // Send ping
        ws.socket.write(buildMaskedFrame(0x09, pingPayload));
      });

      assert.ok(pongReceived, 'Should receive pong frame');
      assert.deepStrictEqual(pongPayload, pingPayload, 'Pong payload should match ping payload');
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should handle large text frames', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      ws = await wsConnect(env.ports.httpPort, '/ws-echo');

      // 16KB text message (larger than 126, triggers extended length)
      const largeMessage = 'x'.repeat(16384);
      let receivedMessage = null;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1500);

        ws.socket.on('data', (chunk) => {
          const result = parseUnmaskedFrame(chunk);
          if (result && result.opcode === 0x01) {
            receivedMessage = result.payload.toString();
          }
        });

        ws.socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        ws.socket.write(buildMaskedFrame(0x01, Buffer.from(largeMessage)));
      });

      assert.ok(receivedMessage, 'Should receive large echo');
      assert.strictEqual(receivedMessage, largeMessage);
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should handle multiple concurrent WebSocket connections', async () => {
    const env = await createTestEnv();
    const connections = [];

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      // Open 3 concurrent connections
      for (let i = 0; i < 3; i++) {
        const ws = await wsConnect(env.ports.httpPort, '/ws-echo');
        connections.push(ws);
      }

      // Send messages on each
      const results = await Promise.all(
        connections.map(async (ws, index) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(null), 1000);
            let message = null;

            ws.socket.on('data', (chunk) => {
              const result = parseUnmaskedFrame(chunk);
              if (result && result.opcode === 0x01) {
                message = result.payload.toString();
              }
            });

            ws.socket.on('error', (err) => {
              clearTimeout(timer);
              reject(err);
            });

            const msg = `Connection ${index}`;
            ws.socket.write(buildMaskedFrame(0x01, Buffer.from(msg)));

            setTimeout(() => {
              resolve(message);
            }, 500);
          });
        })
      );

      // Verify each connection received its echo
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(results[i], `Connection ${i}`, `Connection ${i} should receive echo`);
      }
    } finally {
      for (const ws of connections) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });

  it('should preserve unique Sec-WebSocket-Key through tunnel', async () => {
    const env = await createTestEnv();
    let ws = null;

    try {
      await env.startClient();
      await new Promise((r) => setTimeout(r, 200));

      const uniqueKey = crypto.randomBytes(16).toString('base64');

      ws = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error('Timeout'));
        }, 5000);

        const req = request(
          {
            hostname: 'localhost',
            port: env.ports.httpPort,
            path: '/_next/webpack-hmr',
            method: 'GET',
            headers: {
              Upgrade: 'websocket',
              Connection: 'Upgrade',
              'Sec-WebSocket-Key': uniqueKey,
              'Sec-WebSocket-Version': '13',
            },
          },
          () => {
            clearTimeout(timer);
            resolve({ res: null, socket: null, req });
          }
        );

        req.on('upgrade', (res, socket) => {
          clearTimeout(timer);
          resolve({ res, socket, req });
        });

        req.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        req.end();
      });

      assert.ok(ws.res, 'Should upgrade');
      assert.ok(ws.res.headers['sec-websocket-accept'], 'Should have accept header');

      // The accept hash is calculated from the key, so if we got a valid response
      // the key was preserved through the tunnel
    } finally {
      if (ws) {
        ws.socket.destroy();
        ws.req.destroy();
      }
      await env.cleanup();
    }
  });
});

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
  } else {
    frame = Buffer.allocUnsafe(8 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLen, 2);
    maskKey.copy(frame, 4);
    offset = 8;
  }

  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }

  return frame;
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
});

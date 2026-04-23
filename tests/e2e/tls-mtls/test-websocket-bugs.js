const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const { request } = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

// Helper to build masked WebSocket client frame
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

// Helper to parse unmasked WebSocket server frame
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
    payloadLen = buffer.readUInt32BE(6);
    offset = 10;
  }

  if (buffer.length < offset + payloadLen) return null;

  const payload = buffer.subarray(offset, offset + payloadLen);
  const remaining = buffer.subarray(offset + payloadLen);

  return { fin, opcode, payload, remaining };
}

describe('WebSocket Bug Fixes', () => {
  describe('Bug #21 - Close frame race condition', () => {
    it('should complete proper WebSocket close handshake without TCP reset', async () => {
      const env = await createTestEnv();

      try {
        await env.startClient();
        await new Promise((r) => setTimeout(r, 300));

        // Create WebSocket connection
        const ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WS connect timeout')), 5000);

          const req = request(
            {
              hostname: 'localhost',
              port: env.ports.httpPort,
              path: '/ws-echo',
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

        assert.strictEqual(ws.res.statusCode, 101, 'Should upgrade to WebSocket');

        // First send a message and get echo to confirm connection works
        const testMsg = 'test-before-close';
        ws.socket.write(buildMaskedFrame(0x01, Buffer.from(testMsg)));

        let echoReceived = false;
        let buffer = Buffer.alloc(0);
        let closeReceived = false;
        let socketHadError = false;

        // Wait for echo first
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 1000);

          ws.socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Skip HTTP headers if still present
            const headerEnd = buffer.indexOf('\r\n\r\n');
            let wsData = headerEnd >= 0 ? buffer.subarray(headerEnd + 4) : buffer;

            while (wsData.length >= 2) {
              const result = parseUnmaskedFrame(wsData);
              if (!result) break;

              wsData = result.remaining;
              buffer = wsData; // Update buffer to remaining data

              if (result.opcode === 0x01) {
                const text = result.payload.toString();
                if (text === testMsg) {
                  echoReceived = true;
                  clearTimeout(timer);
                  resolve();
                }
              }
            }
          });

          ws.socket.on('error', (err) => {
            socketHadError = true;
            clearTimeout(timer);
            reject(err);
          });
        });

        assert.ok(echoReceived, 'Should have received echo before close');

        // Now initiate close from client side
        const closeCode = Buffer.from([0x03, 0xe8]); // 1000 = normal closure
        ws.socket.write(buildMaskedFrame(0x08, closeCode));

        // Wait for close frame response with timeout
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 1500);

          ws.socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            const headerEnd = buffer.indexOf('\r\n\r\n');
            let wsData = headerEnd >= 0 ? buffer.subarray(headerEnd + 4) : buffer;

            while (wsData.length >= 2) {
              const result = parseUnmaskedFrame(wsData);
              if (!result) break;

              wsData = result.remaining;

              if (result.opcode === 0x08) {
                closeReceived = true;
                clearTimeout(timer);
                resolve();
              }
            }
          });

          ws.socket.on('error', () => {
            socketHadError = true;
          });

          ws.socket.on('close', (hadError) => {
            if (hadError) socketHadError = true;
          });
        });

        // Clean up
        ws.socket.destroy();
        ws.req.destroy();

        assert.ok(closeReceived, 'Should receive close frame response (bug #21 fix) - indicates clean close handshake');
        assert.ok(!socketHadError, 'Socket should not have error - indicates clean close (bug #21 fix)');
      } finally {
        await env.cleanup();
      }
    });
  });
});

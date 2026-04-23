const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const { request } = require('node:http');
const { createServer } = require('node:http');
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

// Create a mock target that returns title-cased headers (bug #23)
function createCaseSensitiveHeaderTarget(port) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  server.on('upgrade', (req, socket, head) => {
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      'X-Custom-Header: test-value',
      '',
      ''
    ].join('\r\n');
    
    socket.write(headers);
    
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const result = parseWsFrame(buffer);
        if (!result) break;
        buffer = result.remaining;
        
        if (result.opcode === 0x01 || result.opcode === 0x02) {
          const echo = buildWsFrame(result.opcode, result.payload);
          socket.write(echo);
        } else if (result.opcode === 0x08) {
          socket.write(buildWsFrame(0x08, result.payload));
          socket.end();
        }
      }
    });
  });

  function parseWsFrame(buffer) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLen = buffer[1] & 0x7f;
    let offset = 2;
    
    if (payloadLen === 126) {
      if (buffer.length < 4) return null;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    }
    
    if (masked) {
      if (buffer.length < offset + 4 + payloadLen) return null;
      const maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = buffer.subarray(offset, offset + payloadLen);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
      return { opcode, payload, remaining: buffer.subarray(offset + payloadLen) };
    }
    
    if (buffer.length < offset + payloadLen) return null;
    return { 
      opcode, 
      payload: buffer.subarray(offset, offset + payloadLen),
      remaining: buffer.subarray(offset + payloadLen)
    };
  }

  function buildWsFrame(opcode, payload) {
    const frame = Buffer.allocUnsafe(2 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = payload.length;
    payload.copy(frame, 2);
    return frame;
  }

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

// Create a mock target that never responds to upgrades (bug #24)
function createHangingUpgradeTarget(port) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  server.on('upgrade', (req, socket, head) => {
    // Never respond - just hang
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

describe('Bug Fixes', () => {
  describe('#23 - Case-sensitive header dedup', () => {
    it('should not send duplicate headers when target returns title-cased headers', async () => {
      const env = await createTestEnv();
      let ws = null;
      let customTarget = null;

      try {
        await new Promise(r => env.servers.mockTarget.close(r));
        customTarget = await createCaseSensitiveHeaderTarget(env.ports.targetPort);
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('WS connect timeout'));
          }, 5000);

          const req = request(
            {
              hostname: 'localhost',
              port: env.ports.httpPort,
              path: '/ws-test',
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

        assert.strictEqual(ws.res.statusCode, 101);
        
        const rawHeaders = ws.res.rawHeaders;
        let upgradeNameCount = 0;
        let connectionNameCount = 0;
        for (let i = 0; i < rawHeaders.length; i += 2) {
          const name = rawHeaders[i].toLowerCase();
          if (name === 'upgrade') upgradeNameCount++;
          if (name === 'connection') connectionNameCount++;
        }
        
        assert.strictEqual(upgradeNameCount, 1, 'Upgrade header should appear exactly once');
        assert.strictEqual(connectionNameCount, 1, 'Connection header should appear exactly once');
        
        let echoReceived = false;
        const msg = 'Hello';
        
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 1000);
          
          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x01) {
              const text = result.payload.toString();
              if (text === msg) {
                echoReceived = true;
              }
            }
          });
          
          ws.socket.on('error', reject);
          ws.socket.write(buildMaskedFrame(0x01, Buffer.from(msg)));
        });
        
        assert.ok(echoReceived, 'WebSocket should still work for message echo');
        
      } finally {
        if (ws) {
          ws.socket.destroy();
          ws.req.destroy();
        }
        if (customTarget) {
          customTarget.close();
          await new Promise(r => setTimeout(r, 50));
        }
        await env.cleanup();
      }
    });
  });

  describe('#24 - WS upgrade timeout', () => {
    it('should timeout if target never responds to upgrade request', async () => {
      const env = await createTestEnv();
      let hangingTarget = null;
      let socket = null;

      try {
        await new Promise(r => env.servers.mockTarget.close(r));
        hangingTarget = await createHangingUpgradeTarget(env.ports.targetPort);
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        const startTime = Date.now();
        
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({ timeout: true });
          }, 35000);

          const req = request(
            {
              hostname: 'localhost',
              port: env.ports.httpPort,
              path: '/ws-test',
              method: 'GET',
              headers: {
                Upgrade: 'websocket',
                Connection: 'Upgrade',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version': '13',
              },
            },
            (res) => {
              clearTimeout(timer);
              resolve({ httpResponse: true, status: res.statusCode });
            }
          );

          req.on('upgrade', (res, sock) => {
            clearTimeout(timer);
            socket = sock;
            resolve({ upgraded: true });
          });

          req.on('error', (err) => {
            clearTimeout(timer);
            resolve({ error: err.message });
          });

          req.end();
        });

        const elapsed = Date.now() - startTime;
        assert.ok(elapsed < 35000, 'Should timeout before 35 seconds');
        assert.ok(!result.upgraded, 'Should not successfully upgrade to hanging target');
        
      } finally {
        if (socket) socket.destroy();
        if (hangingTarget) {
          hangingTarget.close();
          await new Promise(r => setTimeout(r, 50));
        }
        await env.cleanup();
      }
    });
  });

  describe('#25 - Idle timer without fragile listener wrapping', () => {
    it('should reset idle timer on data without breaking existing data handlers', async () => {
      const env = await createTestEnv();
      let ws = null;

      try {
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('WS connect timeout'));
          }, 5000);

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

        assert.strictEqual(ws.res.statusCode, 101);

        const messages = [];
        
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 1000);
          
          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x01) {
              messages.push(result.payload.toString());
            }
          });
          
          ws.socket.on('error', reject);
          
          ws.socket.write(buildMaskedFrame(0x01, Buffer.from('First')));
          setTimeout(() => ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Second'))), 100);
          setTimeout(() => ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Third'))), 200);
        });
        
        assert.ok(messages.includes('First'), 'Should receive first message echo');
        assert.ok(messages.includes('Second'), 'Should receive second message echo');
        assert.ok(messages.includes('Third'), 'Should receive third message echo');
        
        await new Promise(r => setTimeout(r, 500));
        
        let lateEcho = false;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 1000);
          
          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x01) {
              if (result.payload.toString() === 'Late') {
                lateEcho = true;
              }
            }
          });
          
          ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Late')));
        });
        
        assert.ok(lateEcho, 'Should still receive echo after idle timer reset');
        
      } finally {
        if (ws) {
          ws.socket.destroy();
          ws.req.destroy();
        }
        await env.cleanup();
      }
    });

    it('should handle multiple data listeners without disruption', async () => {
      const env = await createTestEnv();
      let ws = null;
      const listener1Calls = [];
      const listener2Calls = [];

      try {
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('WS connect timeout'));
          }, 5000);

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

        assert.strictEqual(ws.res.statusCode, 101);
        
        ws.socket.on('data', (chunk) => {
          listener1Calls.push(chunk.length);
        });
        
        await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(), 500);
          
          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x01) {
              listener2Calls.push(result.payload.toString());
            }
          });
          
          ws.socket.write(buildMaskedFrame(0x01, Buffer.from('Test')));
        });
        
        assert.ok(listener1Calls.length > 0, 'First listener should receive data');
        assert.ok(listener2Calls.includes('Test'), 'Second listener should receive echo');
        
      } finally {
        if (ws) {
          ws.socket.destroy();
          ws.req.destroy();
        }
        await env.cleanup();
      }
    });
  });

  describe('#26 - O(n²) buffer growth regression test', () => {
    it('should handle multiple sequential messages correctly', async () => {
      const env = await createTestEnv();
      let ws = null;

      try {
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('WS connect timeout'));
          }, 5000);

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

        assert.strictEqual(ws.res.statusCode, 101);

        // Send 10 messages with small delays (backpressure-friendly)
        const messageCount = 10;
        const messages = [];
        const received = [];

        for (let i = 0; i < messageCount; i++) {
          messages.push(`ChunkTest-${i}-${'x'.repeat(100)}`);
        }

        await new Promise((resolve, reject) => {
          let receivedCount = 0;

          const timer = setTimeout(() => {
            resolve(); // Resolve on timeout, we'll check counts after
          }, 5000);

          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x01) {
              const text = result.payload.toString();
              received.push(text);
              receivedCount++;

              if (receivedCount === messageCount) {
                clearTimeout(timer);
                resolve();
              }
            }
          });

          ws.socket.on('error', reject);

          // Send messages with small delays to avoid overwhelming buffers
          for (let i = 0; i < messages.length; i++) {
            setTimeout(() => {
              ws.socket.write(buildMaskedFrame(0x01, Buffer.from(messages[i])));
            }, i * 20);
          }
        });

        assert.strictEqual(received.length, messageCount, `Should receive all ${messageCount} messages`);
        for (let i = 0; i < messageCount; i++) {
          assert.ok(received.includes(messages[i]), `Should include message ${i}`);
        }

      } finally {
        if (ws) {
          ws.socket.destroy();
          ws.req.destroy();
        }
        await env.cleanup();
      }
    });

    it('should handle medium-sized binary messages', async () => {
      const env = await createTestEnv();
      let ws = null;

      try {
        await env.startClient();
        await new Promise((r) => setTimeout(r, 200));

        ws = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('WS connect timeout'));
          }, 5000);

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

        assert.strictEqual(ws.res.statusCode, 101);

        // Send a 50KB binary message
        const testData = crypto.randomBytes(50 * 1024);
        let receivedData = null;

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 3000);

          ws.socket.on('data', (chunk) => {
            const result = parseUnmaskedFrame(chunk);
            if (result && result.opcode === 0x02) {
              receivedData = result.payload;
              clearTimeout(timer);
              resolve();
            }
          });

          ws.socket.on('error', reject);
          ws.socket.write(buildMaskedFrame(0x02, testData));
        });

        assert.ok(receivedData, 'Should receive binary echo');
        assert.strictEqual(receivedData.length, testData.length, 'Data length should match');
        // Verify samples
        assert.deepStrictEqual(receivedData.subarray(0, 100), testData.subarray(0, 100), 'First 100 bytes should match');
        assert.deepStrictEqual(receivedData.subarray(-100), testData.subarray(-100), 'Last 100 bytes should match');

      } finally {
        if (ws) {
          ws.socket.destroy();
          ws.req.destroy();
        }
        await env.cleanup();
      }
    });
  });


});

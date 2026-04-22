// Test: WebSocket Support

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const crypto = require('node:crypto');
const { request } = require('node:http');

// Build masked client frame (browser->server)
function buildMaskedWebSocketFrame(opcode, payload) {
  const payloadLen = payload.length;
  const maskKey = crypto.randomBytes(4);
  let frame;
  let offset;
  
  if (payloadLen < 126) {
    frame = Buffer.allocUnsafe(2 + 4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payloadLen;
    maskKey.copy(frame, 2);
    offset = 6;
  } else {
    frame = Buffer.allocUnsafe(4 + 4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLen, 2);
    maskKey.copy(frame, 4);
    offset = 8;
  }
  
  // Copy and mask payload
  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }
  
  return frame;
}

describe('WebSocket Support', () => {
  it('should complete WebSocket handshake', async () => {
    const env = await createTestEnv();
    let wsSocket = null;
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const result = await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/ws-echo',
          method: 'GET',
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13'
          }
        }, (res) => {
          resolve({ upgraded: false, statusCode: res.statusCode });
        });
        
        req.on('upgrade', (res, socket, head) => {
          wsSocket = socket;
          resolve({ 
            upgraded: true, 
            statusCode: res.statusCode,
            headers: res.headers
          });
        });
        
        req.on('error', reject);
        req.end();
        
        setTimeout(() => {
          req.destroy();
          reject(new Error('Timeout'));
        }, 3000);
      });
      
      assert.ok(result.upgraded, 'Should upgrade to WebSocket');
      assert.strictEqual(result.statusCode, 101);
      assert.ok(result.headers['sec-websocket-accept'], 'Should have Sec-WebSocket-Accept');
      assert.strictEqual(result.headers.upgrade, 'websocket');
    } finally {
      // Important: Destroy WebSocket socket before cleanup
      if (wsSocket) {
        wsSocket.destroy();
        await new Promise(r => setTimeout(r, 100));
      }
      await env.cleanup();
    }
  });

  it('should relay WebSocket text frames', async () => {
    const env = await createTestEnv();
    let wsSocket = null;
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const messages = [];
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 2000);
        
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/ws-echo',
          method: 'GET',
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13'
          }
        }, (res) => {
          clearTimeout(timeout);
          reject(new Error('Got HTTP response instead of upgrade'));
        });
        
        req.on('upgrade', (res, socket, head) => {
          wsSocket = socket;
          
          socket.on('data', (chunk) => {
            // Parse simple text frame (unmasked from server)
            if (chunk.length >= 2) {
              const opcode = chunk[0] & 0x0f;
              const payloadLen = chunk[1] & 0x7f;
              if (opcode === 0x01 && chunk.length >= 2 + payloadLen) {
                const payload = chunk.subarray(2, 2 + payloadLen);
                messages.push(payload.toString());
              }
            }
          });
          
          socket.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
          
          socket.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          
          // Send masked text frame
          const frame = buildMaskedWebSocketFrame(0x01, Buffer.from('Hello WebSocket'));
          socket.write(frame);
          
          // Close after receiving echo
          setTimeout(() => {
            const closeFrame = buildMaskedWebSocketFrame(0x08, Buffer.alloc(0));
            socket.write(closeFrame);
            socket.end();
          }, 300);
        });
        
        req.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        
        req.end();
      });
      
      assert.ok(messages.some(m => m.includes('Hello WebSocket')), 'Should receive echo');
    } finally {
      if (wsSocket) {
        wsSocket.destroy();
        await new Promise(r => setTimeout(r, 100));
      }
      await env.cleanup();
    }
  });

  it('should handle WebSocket close frame', async () => {
    const env = await createTestEnv();
    let wsSocket = null;
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      let closeReceived = false;
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 2000);
        
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/ws-echo',
          method: 'GET',
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13'
          }
        }, (res) => {
          clearTimeout(timeout);
          reject(new Error('Got HTTP response'));
        });
        
        req.on('upgrade', (res, socket, head) => {
          wsSocket = socket;
          
          socket.on('data', (chunk) => {
            const opcode = chunk[0] & 0x0f;
            if (opcode === 0x08) {
              closeReceived = true;
            }
          });
          
          socket.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
          
          // Send close frame
          setTimeout(() => {
            const closeFrame = buildMaskedWebSocketFrame(0x08, Buffer.alloc(0));
            socket.write(closeFrame);
          }, 100);
        });
        
        req.on('error', reject);
        req.end();
      });
      
      assert.ok(closeReceived, 'Should receive close frame response');
    } finally {
      if (wsSocket) {
        wsSocket.destroy();
        await new Promise(r => setTimeout(r, 100));
      }
      await env.cleanup();
    }
  });

  it('should preserve Sec-WebSocket-Key through tunnel', async () => {
    const env = await createTestEnv();
    let wsSocket = null;
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      // Create unique key
      const uniqueKey = crypto.randomBytes(16).toString('base64');
      
      const result = await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/_next/webpack-hmr',
          method: 'GET',
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': uniqueKey,
            'Sec-WebSocket-Version': '13'
          }
        }, (res) => {
          resolve({ upgraded: false });
        });
        
        req.on('upgrade', (res, socket, head) => {
          wsSocket = socket;
          resolve({ upgraded: true, headers: res.headers });
        });
        
        req.on('error', reject);
        req.end();
        
        setTimeout(() => {
          req.destroy();
          reject(new Error('Timeout'));
        }, 3000);
      });
      
      assert.ok(result.upgraded, 'Should upgrade');
      // Verify accept hash is present (means target received the key)
      assert.ok(result.headers['sec-websocket-accept'], 'Should have accept header');
    } finally {
      if (wsSocket) {
        wsSocket.destroy();
        await new Promise(r => setTimeout(r, 100));
      }
      await env.cleanup();
    }
  });
});

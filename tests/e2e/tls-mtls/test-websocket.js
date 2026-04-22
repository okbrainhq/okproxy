const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const crypto = require('node:crypto');
const { request } = require('node:http');

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
  
  for (let i = 0; i < payload.length; i++) {
    frame[offset + i] = payload[i] ^ maskKey[i % 4];
  }
  
  return frame;
}

function wsConnect(httpPort, path) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'localhost',
      port: httpPort,
      path: path || '/ws-echo',
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13'
      }
    }, (res) => {
      reject(new Error('Got HTTP response: ' + res.statusCode));
    });
    
    req.on('upgrade', (res, socket, head) => {
      resolve({ res, socket });
    });
    
    req.on('error', reject);
    req.end();
    
    setTimeout(() => {
      req.destroy();
      reject(new Error('WebSocket connect timeout'));
    }, 5000);
  });
}

describe('WebSocket Support', () => {
  it('should complete WebSocket handshake', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const { res, socket } = await wsConnect(env.ports.httpPort, '/ws-echo');
      
      assert.strictEqual(res.statusCode, 101);
      assert.ok(res.headers['sec-websocket-accept'], 'Should have Sec-WebSocket-Accept');
      assert.strictEqual(res.headers.upgrade, 'websocket');
      
      socket.destroy();
    } finally {
      await new Promise(r => setTimeout(r, 100));
      await env.cleanup();
    }
  });

  it('should relay WebSocket text frames', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const { socket } = await wsConnect(env.ports.httpPort, '/ws-echo');
      const messages = [];
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 2000);
        
        socket.on('data', (chunk) => {
          if (chunk.length >= 2) {
            const opcode = chunk[0] & 0x0f;
            const payloadLen = chunk[1] & 0x7f;
            if (opcode === 0x01 && chunk.length >= 2 + payloadLen) {
              const payload = chunk.subarray(2, 2 + payloadLen);
              messages.push(payload.toString());
            }
          }
        });
        
        socket.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        
        socket.write(buildMaskedWebSocketFrame(0x01, Buffer.from('Hello WebSocket')));
        
        setTimeout(() => {
          socket.write(buildMaskedWebSocketFrame(0x08, Buffer.alloc(0)));
          socket.end();
        }, 300);
      });
      
      assert.ok(messages.some(m => m.includes('Hello WebSocket')), 'Should receive echo');
      
      socket.destroy();
    } finally {
      await new Promise(r => setTimeout(r, 100));
      await env.cleanup();
    }
  });

  it('should handle WebSocket close frame', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const { socket } = await wsConnect(env.ports.httpPort, '/ws-echo');
      let closeReceived = false;
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 2000);
        
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
        
        socket.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        
        setTimeout(() => {
          socket.write(buildMaskedWebSocketFrame(0x08, Buffer.alloc(0)));
        }, 100);
      });
      
      assert.ok(closeReceived, 'Should receive close frame response');
      
      socket.destroy();
    } finally {
      await new Promise(r => setTimeout(r, 100));
      await env.cleanup();
    }
  });

  it('should preserve Sec-WebSocket-Key through tunnel', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      await new Promise(r => setTimeout(r, 200));
      
      const uniqueKey = crypto.randomBytes(16).toString('base64');
      
      const { res, socket } = await new Promise((resolve, reject) => {
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
        }, () => resolve({ res: null, socket: null }));
        
        req.on('upgrade', (res, socket) => resolve({ res, socket }));
        req.on('error', reject);
        req.end();
        
        setTimeout(() => {
          req.destroy();
          reject(new Error('Timeout'));
        }, 3000);
      });
      
      assert.ok(res, 'Should upgrade');
      assert.ok(res.headers['sec-websocket-accept'], 'Should have accept header');
      
      socket.destroy();
    } finally {
      await new Promise(r => setTimeout(r, 100));
      await env.cleanup();
    }
  });
});

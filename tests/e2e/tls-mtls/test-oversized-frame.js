// Test 13: Oversized Frame Rejection (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { connect } = require('node:tls');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');
const { createTestEnv } = require('./setup');

describe('Oversized Frame Rejection', () => {
  it('should destroy connection on oversized frame header', async () => {
    const env = await createTestEnv();
    
    try {
      // Connect directly to test at protocol level
      const socket = connect({ port: env.ports.tlsPort });
      
      let disconnected = false;
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          // First send INIT
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            version: 1,
            clientId: 'test-oversized'
          })));

          // Wait for INIT response
          setTimeout(() => {
            // Now send oversized frame header
            const oversizedHeader = Buffer.alloc(9);
            oversizedHeader.writeUInt32BE(1, 0); // streamId
            oversizedHeader.writeUInt8(FrameType.DATA, 4); // type
            oversizedHeader.writeUInt32BE(MAX_FRAME_SIZE + 1, 5); // length > max

            socket.write(oversizedHeader);
          }, 200);
        });

        // Must consume incoming data so socket enters flowing mode
        // and can detect when the server closes the connection
        socket.on('data', () => {});

        socket.on('close', () => {
          disconnected = true;
          resolve();
        });

        socket.on('error', () => {});
        setTimeout(resolve, 2000);
      });
      
      assert.ok(disconnected, 'Should be disconnected for oversized frame');
    } finally {
      await env.cleanup();
    }
  });

  it('should not allocate memory for oversized frame', async () => {
    const env = await createTestEnv();
    
    try {
      const socket = connect({ port: env.ports.tlsPort });
      
      let disconnected = false;
      const startMem = process.memoryUsage().heapUsed;
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            version: 1,
            clientId: 'test-mem'
          })));

          setTimeout(() => {
            // Send header claiming huge payload
            const header = Buffer.alloc(9);
            header.writeUInt32BE(1, 0);
            header.writeUInt8(FrameType.DATA, 4);
            header.writeUInt32BE(100 * 1024 * 1024, 5); // 100MB claimed

            socket.write(header);
            // Don't send the actual payload
          }, 200);
        });

        // Must consume incoming data so socket enters flowing mode
        socket.on('data', () => {});

        socket.on('close', () => {
          disconnected = true;
          resolve();
        });

        socket.on('error', () => {});
        setTimeout(resolve, 2000);
      });
      
      const endMem = process.memoryUsage().heapUsed;
      const memIncrease = endMem - startMem;
      
      assert.ok(disconnected, 'Should disconnect');
      // Should not allocate 100MB
      assert.ok(memIncrease < 50 * 1024 * 1024, 'Should not allocate huge memory');
    } finally {
      await env.cleanup();
    }
  });
});

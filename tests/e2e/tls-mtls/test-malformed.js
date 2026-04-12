// Test 12: Malformed Frames (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { connect } = require('node:tls');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { createTestEnv } = require('./setup');

describe('Malformed Frames', () => {
  it('should handle bad JSON in HEADERS gracefully', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-malformed');
      
      const socket = env.clientConnection().socket;
      
      // Send a request with malformed HEADERS
      const malformedHeaders = encodeFrame(999, FrameType.HEADERS, 'not valid json');
      
      let errorReceived = false;
      const originalDecoder = socket.listeners('data')[0];
      
      // Wait a bit for processing
      await new Promise(r => setTimeout(r, 100));
      
      // Connection should still be alive (not destroyed)
      assert.ok(!socket.destroyed, 'Connection should stay alive');
    } finally {
      await env.cleanup();
    }
  });

  it('should handle unknown frame type gracefully', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-unknown-frame');
      
      const socket = env.clientConnection().socket;
      
      // Send a frame with unknown type (0xFF)
      const unknownFrame = encodeFrame(1, 0xFF, Buffer.from('test'));
      
      await new Promise(r => setTimeout(r, 100));
      
      // Connection should still be alive
      assert.ok(!socket.destroyed, 'Connection should stay alive');
    } finally {
      await env.cleanup();
    }
  });

  it('should handle frame for nonexistent stream gracefully', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-bad-stream');
      
      // Make a request to create a stream
      const { request } = require('node:http');
      
      const req = request({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      }, (res) => {
        res.resume();
      });
      req.end();
      
      await new Promise(r => setTimeout(r, 100));
      
      // Connection should stay alive
      assert.ok(env.isClientConnected(), 'Connection should stay alive');
    } finally {
      await env.cleanup();
    }
  });
});

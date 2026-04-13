// Test 9: Large Body (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('Large Body', () => {
  it('should handle 1MB response', async () => {
    const env = await createTestEnv({
      mockTarget: { largeSize: 1024 * 1024 }
    });
    
    try {
      await env.startClient('test-large');
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/large',
        method: 'GET'
      });
      
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body.length, 1024 * 1024);
    } finally {
      await env.cleanup();
    }
  });

  it('should handle 10MB POST body', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient('test-large-post');

      const size = 10 * 1024 * 1024; // 10MB
      const largeBody = Buffer.alloc(size, 'x');

      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: largeBody
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      const echoedBody = Buffer.from(body.body, 'base64');
      assert.strictEqual(echoedBody.length, size);
    } finally {
      await env.cleanup();
    }
  });

  it('should handle single chunk >1MB without frame size error', async () => {
    // This tests that large chunks are split into multiple frames
    // If not split, the decoder would reject with "Frame too large"
    const env = await createTestEnv();

    try {
      await env.startClient('test-chunk-splitting');

      // Send 2MB in a single chunk - requires splitting into 2 frames
      const size = 2 * 1024 * 1024;
      const largeBody = Buffer.alloc(size, 'y');

      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: largeBody
      });

      // Should succeed without "Frame too large" error
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      const echoedBody = Buffer.from(body.body, 'base64');
      assert.strictEqual(echoedBody.length, size);
      // Verify content integrity
      assert.strictEqual(echoedBody.toString(), largeBody.toString());
    } finally {
      await env.cleanup();
    }
  });

  it('should handle response with single chunk >1MB', async () => {
    // Test that response chunks >1MB are also split properly
    const env = await createTestEnv({
      mockTarget: { largeSize: 2 * 1024 * 1024 } // 2MB response
    });

    try {
      await env.startClient('test-large-response-chunk');

      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/large',
        method: 'GET'
      });

      // Should succeed without "Frame too large" error
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body.length, 2 * 1024 * 1024);
      // Verify content
      assert.ok(response.body.every(b => b === 0x78), 'All bytes should be "x"');
    } finally {
      await env.cleanup();
    }
  });
});

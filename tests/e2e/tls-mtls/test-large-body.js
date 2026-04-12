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
});

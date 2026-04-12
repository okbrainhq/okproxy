// Test 5: Simple HTTP POST (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('HTTP POST', () => {
  it('should proxy POST request body to target', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post');
      
      const requestBody = JSON.stringify({ foo: 'bar', num: 42 });
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: Buffer.from(requestBody)
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.method, 'POST');
      assert.strictEqual(body.path, '/echo');
      
      // Verify body was echoed
      const echoedBody = Buffer.from(body.body, 'base64').toString();
      assert.strictEqual(echoedBody, requestBody);
    } finally {
      await env.cleanup();
    }
  });

  it('should stream large POST body', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post-large');
      
      const largeBody = Buffer.alloc(100 * 1024, 'x'); // 100KB
      
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
      
      // Verify body was received completely
      const echoedBody = Buffer.from(body.body, 'base64');
      assert.strictEqual(echoedBody.length, largeBody.length);
    } finally {
      await env.cleanup();
    }
  });

  it('should handle POST with empty body', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post-empty');
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST'
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.method, 'POST');
    } finally {
      await env.cleanup();
    }
  });
});

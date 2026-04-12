// Test 6: Concurrent Requests (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('Concurrent Requests', () => {
  it('should handle 5 parallel requests', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-concurrent');
      
      // Send 5 parallel requests
      const requests = Array(5).fill(null).map((_, i) => 
        httpRequest({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: `/json?req=${i}`,
          method: 'GET'
        })
      );
      
      const responses = await Promise.all(requests);
      
      // All should succeed
      assert.strictEqual(responses.length, 5);
      responses.forEach((res, i) => {
        assert.strictEqual(res.statusCode, 200, `Request ${i} should succeed`);
        const body = JSON.parse(res.body.toString());
        assert.strictEqual(body.message, 'hello world');
      });
    } finally {
      await env.cleanup();
    }
  });

  it('should handle mixed GET and POST concurrently', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-mixed');
      
      const requests = [
        httpRequest({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/json',
          method: 'GET'
        }),
        httpRequest({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/echo',
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: Buffer.from('post data')
        }),
        httpRequest({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/json',
          method: 'GET'
        })
      ];
      
      const responses = await Promise.all(requests);
      
      assert.strictEqual(responses[0].statusCode, 200);
      assert.strictEqual(responses[1].statusCode, 200);
      assert.strictEqual(responses[2].statusCode, 200);
    } finally {
      await env.cleanup();
    }
  });
});

// Test 4: Simple HTTP GET (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('HTTP GET', () => {
  it('should proxy GET request to target', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.message, 'hello world');
    } finally {
      await env.cleanup();
    }
  });

  it('should return 502 when client not connected', async () => {
    const env = await createTestEnv();
    
    try {
      // Don't start client
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      assert.strictEqual(response.statusCode, 502);
    } finally {
      await env.cleanup();
    }
  });

  it('should work with root path', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/',
        method: 'GET'
      });
      
      // Root path returns 404 from mock target (no route defined for /)
      assert.strictEqual(response.statusCode, 404);
    } finally {
      await env.cleanup();
    }
  });
});

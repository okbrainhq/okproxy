// Test 16: Max Concurrent Streams (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('Max Concurrent Streams', () => {
  it('should enforce max concurrent streams limit', async () => {
    const env = await createTestEnv({
      maxStreams: 2
    });
    
    try {
      await env.startClient('test-max-streams');
      
      // Start 2 requests that will hang
      const { request } = require('node:http');
      
      const req1 = request({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/hang',
        method: 'GET'
      }, () => {});
      req1.on('error', () => {});
      req1.end();
      
      const req2 = request({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/hang',
        method: 'GET'
      }, () => {});
      req2.on('error', () => {});
      req2.end();
      
      // Wait for streams to be established
      await new Promise(r => setTimeout(r, 100));
      
      // Try a 3rd request
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      // Should get 503 Service Unavailable
      assert.strictEqual(response.statusCode, 503);
      
      // Clean up hanging requests
      req1.destroy();
      req2.destroy();
    } finally {
      await env.cleanup();
    }
  });

  it('should allow new streams after old ones complete', async () => {
    const env = await createTestEnv({
      maxStreams: 2
    });
    
    try {
      await env.startClient('test-stream-recycle');
      
      // Make 2 quick requests
      const res1 = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      const res2 = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      assert.strictEqual(res1.statusCode, 200);
      assert.strictEqual(res2.statusCode, 200);
      
      // Now make another - should succeed since previous completed
      const res3 = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      assert.strictEqual(res3.statusCode, 200);
    } finally {
      await env.cleanup();
    }
  });
});

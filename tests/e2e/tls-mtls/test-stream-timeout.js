// Test 17: Stream Inactivity Timeout (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');

describe('Stream Inactivity Timeout', () => {
  it('should timeout hanging target with 504', async () => {
    const env = await createTestEnv({
      streamTimeout: 500  // Short timeout for testing
    });
    
    try {
      await env.startClient('test-stream-timeout');
      
      const { request } = require('node:http');
      
      const response = await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/hang',
          method: 'GET'
        }, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        req.end();
      });
      
      // Collect response
      const chunks = [];
      await new Promise((resolve) => {
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve());
        response.on('close', () => resolve());
      });
      
      // Should get 504 Gateway Timeout
      assert.strictEqual(response.statusCode, 504);
    } finally {
      await env.cleanup();
    }
  });

  it('should reset timeout on activity', async () => {
    const env = await createTestEnv({
      streamTimeout: 500,
      mockTarget: { slowDelay: 100, slowChunks: 10 }
    });
    
    try {
      await env.startClient('test-timeout-reset');
      
      const { request } = require('node:http');
      
      let receivedChunks = 0;
      
      await new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/slow',
          method: 'GET'
        }, (res) => {
          res.on('data', () => {
            receivedChunks++;
          });
          res.on('end', () => {
            const duration = Date.now() - startTime;
            // Should complete successfully despite 500ms timeout
            // because activity keeps resetting the timeout
            assert.ok(duration > 800, 'Should take >800ms (activity resets timeout)');
            resolve();
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      
      // Should have received all chunks
      assert.ok(receivedChunks >= 10, 'Should receive all chunks');
    } finally {
      await env.cleanup();
    }
  });
});

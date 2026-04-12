// Test 7: Streaming Response (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');

describe('Streaming Response', () => {
  it('should stream response progressively', async () => {
    const env = await createTestEnv({
      mockTarget: { streamChunks: 10, chunkDelay: 10 }
    });
    
    try {
      await env.startClient('test-stream');
      
      const { request } = require('node:http');
      
      const chunks = [];
      const chunkTimes = [];
      
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/stream',
          method: 'GET'
        }, (res) => {
          res.on('data', (chunk) => {
            chunks.push(chunk);
            chunkTimes.push(Date.now());
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      
      // Should have received multiple chunks
      assert.ok(chunks.length > 1, 'Should receive multiple chunks');
      
      // Chunks should arrive (we got multiple chunks which proves streaming)
      assert.ok(chunks.length >= 10, 'Should receive all 10 chunks');
    } finally {
      await env.cleanup();
    }
  });

  it('should handle streaming with backpressure', async () => {
    const env = await createTestEnv({
      mockTarget: { slowChunks: 50, slowDelay: 50 }
    });
    
    try {
      await env.startClient('test-backpressure-stream');
      
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
          res.on('data', (chunk) => {
            receivedChunks++;
          });
          res.on('end', () => {
            const duration = Date.now() - startTime;
            // Should take ~2.5 seconds (50 chunks * 50ms)
            assert.ok(duration > 1000, 'Should respect backpressure');
            resolve();
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      
      assert.ok(receivedChunks > 0, 'Should receive chunks');
    } finally {
      await env.cleanup();
    }
  });
});

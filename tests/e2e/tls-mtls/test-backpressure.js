// Test 15: Backpressure Under Slow Target (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');

describe('Backpressure', () => {
  it('should not have unbounded memory growth under slow target', async () => {
    const env = await createTestEnv({
      mockTarget: { slowDelay: 200, slowChunks: 10 }
    });
    
    try {
      await env.startClient('test-backpressure');
      
      const { request } = require('node:http');
      
      const startMem = process.memoryUsage().heapUsed;
      
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/slow',
          method: 'GET'
        }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      
      const endMem = process.memoryUsage().heapUsed;
      const memIncrease = endMem - startMem;
      
      // Should not grow by more than 10MB during test
      assert.ok(memIncrease < 10 * 1024 * 1024, 'Memory should not grow unbounded');
    } finally {
      await env.cleanup();
    }
  });

  it('should flow at target pace', async () => {
    const env = await createTestEnv({
      mockTarget: { slowDelay: 100, slowChunks: 5 }
    });
    
    try {
      await env.startClient('test-pace');
      
      const { request } = require('node:http');
      
      const chunkTimes = [];
      
      const startTime = Date.now();
      
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/slow',
          method: 'GET'
        }, (res) => {
          res.on('data', () => {
            chunkTimes.push(Date.now());
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      
      const duration = Date.now() - startTime;
      
      // Should take ~500ms (5 chunks * 100ms each)
      assert.ok(duration > 300, 'Should respect target pace');
    } finally {
      await env.cleanup();
    }
  });
});

// Test 15: Backpressure Under Slow Target (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const { memorySnapshot, startPeakSampler, mb } = require('./memory-utils');

describe('Backpressure', () => {
  it('should not have unbounded memory growth under slow target', async () => {
    const env = await createTestEnv({
      mockTarget: { slowDelay: 200, slowChunks: 10 }
    });
    
    try {
      await env.startClient('test-backpressure');
      
      const { request } = require('node:http');
      
      // Measure peak RSS and native buffer usage, not just a heap delta: frames
      // are relayed through Buffers, so arrayBuffers/external grow first.
      const before = memorySnapshot();
      const sampler = startPeakSampler(20);
      
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
      
      const peak = sampler.stop();
      const rssGrowth = peak.peakRss - before.rss;
      const nativeGrowth = peak.peakArrayBuffers - before.arrayBuffers;
      const heapGrowth = peak.peakHeapUsed - before.heapUsed;

      // Should not grow by more than 32MB RSS / 16MB native buffers during test.
      assert.ok(rssGrowth < 32 * 1024 * 1024,
        `RSS should not grow unbounded (grew ${mb(rssGrowth)}, sampled ${peak.samples}x)`);
      assert.ok(nativeGrowth < 16 * 1024 * 1024,
        `native buffers should not grow unbounded (grew ${mb(nativeGrowth)})`);
      assert.ok(heapGrowth < 10 * 1024 * 1024, 'Memory should not grow unbounded');
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

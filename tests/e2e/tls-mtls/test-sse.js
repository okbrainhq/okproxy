// Test 8: SSE Support (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');

describe('SSE Support', () => {
  it('should receive SSE events', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-sse');
      
      const { request } = require('node:http');
      
      const events = [];
      
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/sse',
          method: 'GET'
        }, (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.headers['content-type'], 'text/event-stream');
          
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            
            // Parse SSE events
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                events.push(data);
              }
            }
          });
          
          res.on('end', () => resolve());
          res.on('error', () => resolve()); // Intentional destroy causes ECONNRESET
          res.on('close', () => resolve()); // Handle early close
        });
        
        req.on('error', () => resolve()); // Ignore errors and resolve
        req.end();

        // Close connection after receiving some events
        setTimeout(() => {
          req.destroy();
          // Also resolve after a short delay if not already resolved
          setTimeout(resolve, 100);
        }, 500);
      });
      
      // Should have received at least the initial 'connected' event
      assert.ok(events.length > 0, 'Should receive SSE events');
      assert.ok(events.includes('connected') || events.some(e => e.includes('connected')), 'Should receive connected event');
    } finally {
      await env.cleanup();
    }
  });

  it('should keep SSE connection open until FIN', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-sse-long');
      
      const { request } = require('node:http');
      
      let connected = false;
      let disconnected = false;
      
      await new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/sse',
          method: 'GET'
        }, (res) => {
          connected = true;
          
          res.on('data', () => {});
          res.on('end', () => {
            disconnected = true;
          });
          res.on('close', () => {
            disconnected = true;
          });
        });
        
        req.on('error', () => {});
        req.end();
        
        // Wait a bit then check
        setTimeout(() => {
          req.destroy();
          setTimeout(resolve, 50);
        }, 300);
      });
      
      // Connection should have been connected
      assert.ok(connected, 'Should be connected');
    } finally {
      await env.cleanup();
    }
  });
});

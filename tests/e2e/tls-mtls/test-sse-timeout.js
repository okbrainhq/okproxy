// Test: SSE Stream Timeout Fix
// Verifies that SSE connections stay open beyond the 30s stream timeout

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');
const { createServer } = require('node:http');

describe('SSE Stream Timeout Fix', () => {
  it('should keep SSE connection open for 60+ seconds with periodic events', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const { request } = require('node:http');
      
      const events = [];
      let connected = false;
      let disconnected = false;
      
      const testPromise = new Promise((resolve, reject) => {
        const req = request({
          hostname: 'localhost',
          port: env.ports.httpPort,
          path: '/sse',
          method: 'GET'
        }, (res) => {
          connected = true;
          
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
          
          res.on('end', () => {
            disconnected = true;
          });
          
          res.on('close', () => {
            disconnected = true;
          });
          
          res.on('error', (err) => {
            disconnected = true;
            reject(new Error(`Response error: ${err.message}`));
          });
        });
        
        req.on('error', (err) => {
          disconnected = true;
          reject(new Error(`Request error: ${err.message}`));
        });
        
        req.end();
        
        // Send periodic SSE events from the mock target every 5 seconds
        // This tests that outgoing DATA frames reset the timeout
        const mockTarget = env.servers.mockTarget;
        const eventInterval = setInterval(() => {
          if (mockTarget && mockTarget.sendSSE) {
            mockTarget.sendSSE({ time: Date.now(), count: events.length });
          }
        }, 5000);
        
        // Keep connection open for 65 seconds (2x the 30s timeout + margin)
        setTimeout(() => {
          clearInterval(eventInterval);
          req.end();  // Gracefully end the request
          // Give time for any pending data and clean close
          setTimeout(() => {
            if (!disconnected) {
              req.destroy();  // Force close if still connected
            }
            resolve();
          }, 500);
        }, 65000);
      });
      
      await testPromise;
      
      // Verify connection stayed open
      assert.ok(connected, 'Should have connected');
      
      // Verify we received events throughout the test
      // Should receive initial 'connected' event + ~13 periodic events (one every 5s for 65s)
      assert.ok(events.length >= 10, `Should receive multiple events throughout 65s test, got ${events.length}`);
      
      // Verify initial connected event was received
      assert.ok(events.includes('connected') || events.some(e => e.includes('connected')), 
        'Should receive initial connected event');
      
      // If we got here without timeout errors, the fix is working
      console.log(`  ✓ SSE connection stayed open for 65+ seconds, received ${events.length} events`);
    } finally {
      await env.cleanup();
    }
  });

  it('should handle slow headers followed by streaming', async () => {
    // This test verifies that receiving HEADERS frame resets the timeout
    // (for targets that take ~29s to send headers, then stream data)
    
    // Create a custom slow-headers mock target
    const slowMockTarget = createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      
      if (urlPath === '/slow-headers') {
        // Wait 25 seconds before sending headers (close to 30s timeout)
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('headers-sent\n');
          
          // Then stream data every 2 seconds
          let count = 0;
          const interval = setInterval(() => {
            count++;
            res.write(`chunk ${count}\n`);
            if (count >= 5) {
              clearInterval(interval);
              res.end();
            }
          }, 2000);
        }, 25000);
        return;
      }
      
      res.writeHead(404);
      res.end('Not Found');
    });
    
    // Start the custom mock target
    await new Promise(resolve => slowMockTarget.listen(0, '127.0.0.1', resolve));
    const slowTargetPort = slowMockTarget.address().port;
    
    // Create test env with custom target port
    // We need to manually set up since createTestEnv creates its own mock target
    const { getPort, getCertPaths, ClientManager } = require('./setup');
    const { createTLSServer } = require('../../../apps/server/lib/tls-server');
    const { createHTTPServer } = require('../../../apps/server/lib/http-router');
    const { createTLSConnection } = require('../../../apps/client/lib/tls-connection');
    const { createProxy } = require('../../../apps/client/lib/proxy');
    
    const certs = getCertPaths();
    const tlsPort = await getPort();
    const httpPort = await getPort();
    
    const clientManager = new (require('../../../apps/server/lib/client-manager').ClientManager)();
    const tlsServer = createTLSServer(clientManager, {
      serverKey: certs.serverKey,
      serverCert: certs.serverCert,
      caCert: certs.caCert,
      caDir: certs.caDir,
      maxConcurrentStreams: 100,
      streamTimeout: 30000,
      keepaliveInterval: 10000,
      keepaliveTimeout: 25000,
      initTimeout: 10000
    });

    const httpServer = createHTTPServer(clientManager, tlsServer, {
      maxConcurrentStreams: 100,
      streamTimeout: 30000
    });

    // Start servers
    await new Promise(resolve => tlsServer.listen(tlsPort, resolve));
    await new Promise(resolve => httpServer.listen(httpPort, resolve));
    
    // Create client connection
    let clientConnection = null;
    let clientProxy = null;
    let clientConnected = false;
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Client connection timeout'));
      }, 5000);

      clientConnection = createTLSConnection(
        {
          serverHost: 'localhost',
          serverPort: tlsPort,
          clientKey: certs.clientKey,
          clientCert: certs.clientCert,
          caCert: certs.clientCa
        },
        (frame) => {
          if (clientProxy) {
            clientProxy.handleFrame(frame);
          }
        },
        () => {
          clearTimeout(timeout);
          clientConnected = true;
          clientProxy = createProxy(clientConnection, slowTargetPort, 'localhost', 100);
          resolve();
        },
        () => {
          clientConnected = false;
          if (clientProxy) {
            clientProxy.destroy();
            clientProxy = null;
          }
        }
      );
    });
    
    try {
      const { request } = require('node:http');
      
      const chunks = [];
      let connected = false;
      
      await new Promise((resolve, reject) => {
        const startTime = Date.now();
        
        const req = request({
          hostname: 'localhost',
          port: httpPort,
          path: '/slow-headers',
          method: 'GET'
        }, (res) => {
          connected = true;
          
          res.on('data', (chunk) => {
            chunks.push(chunk.toString());
          });
          
          res.on('end', () => {
            const duration = Date.now() - startTime;
            // Should take > 30s (25s delay + 10s of streaming)
            assert.ok(duration > 30000, `Should take >30s, took ${duration}ms`);
            resolve();
          });
          
          res.on('error', reject);
        });
        
        req.on('error', reject);
        req.end();
        
        // Timeout after 45s just in case
        setTimeout(() => {
          reject(new Error('Test timed out - slow headers test exceeded 45s'));
        }, 45000);
      });
      
      assert.ok(connected, 'Should have connected');
      
      const body = chunks.join('');
      assert.ok(body.includes('headers-sent'), 'Should receive headers-sent marker');
      assert.ok(body.includes('chunk 1'), 'Should receive streaming chunks');
      assert.ok(body.includes('chunk 5'), 'Should receive all streaming chunks');
      
      console.log(`  ✓ Slow headers test passed - received ${chunks.length} chunks`);
    } finally {
      // Cleanup - must destroy connection to stop reconnection loop
      if (clientProxy) clientProxy.destroy();
      if (clientConnection) clientConnection.destroy();
      await Promise.all([
        new Promise(r => tlsServer.close(r)),
        new Promise(r => httpServer.close(r)),
        new Promise(r => slowMockTarget.close(r))
      ]);
    }
  });
});

// Test: CORS Support and Header Handling (TLS version)
// Note: The tunnel server does NOT add CORS headers automatically.
// CORS is the responsibility of the target service.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('CORS: Tunnel does not add automatic CORS headers', () => {
  it('should NOT add CORS headers - target service is responsible for CORS', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET',
        headers: {
          'Origin': 'http://example.com'
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      // Tunnel should NOT add CORS headers - target doesn't set them
      assert.strictEqual(response.headers['access-control-allow-origin'], undefined,
        'Tunnel should NOT add CORS headers automatically');
    } finally {
      await env.cleanup();
    }
  });

  it('should pass through CORS headers from target service', async () => {
    const env = await createTestEnv({
      mockTarget: {
        corsHeaders: {
          'Access-Control-Allow-Origin': 'https://example.com',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      }
    });
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET',
        headers: {
          'Origin': 'http://example.com'
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      // CORS headers from target should be passed through
      assert.strictEqual(response.headers['access-control-allow-origin'], 'https://example.com',
        'CORS headers from target should be passed through');
    } finally {
      await env.cleanup();
    }
  });

  it('should NOT handle OPTIONS preflight - passes through to target', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      // OPTIONS request should pass through to target (which returns 404)
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/api/test',
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type'
        }
      });
      
      // Mock target returns 404 for unknown paths, not 204
      // This proves OPTIONS is passed through to target, not handled by tunnel
      assert.strictEqual(response.statusCode, 404);
    } finally {
      await env.cleanup();
    }
  });

  it('should NOT add CORS headers to 502 error when no client', async () => {
    const env = await createTestEnv();
    
    try {
      // Don't start client
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET',
        headers: {
          'Origin': 'http://example.com'
        }
      });
      
      assert.strictEqual(response.statusCode, 502);
      // Tunnel should NOT add CORS headers even on errors
      assert.strictEqual(response.headers['access-control-allow-origin'], undefined,
        'Tunnel should NOT add CORS headers even on errors');
    } finally {
      await env.cleanup();
    }
  });

  it('should NOT add CORS headers to 503 when max streams exceeded', async () => {
    const env = await createTestEnv({ maxStreams: 1 });
    
    try {
      await env.startClient();
      
      const { request } = require('node:http');
      
      // Start a hanging request to occupy the stream
      const hangingReq = request({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/hang',
        method: 'GET'
      });
      hangingReq.on('error', () => {});
      hangingReq.end();
      
      // Wait for stream to be established
      await new Promise(r => setTimeout(r, 100));
      
      // Try another request (should get 503)
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET',
        headers: {
          'Origin': 'http://example.com'
        }
      });
      
      assert.strictEqual(response.statusCode, 503);
      assert.strictEqual(response.headers['access-control-allow-origin'], undefined,
        'Tunnel should NOT add CORS headers even on 503 errors');
      
      hangingReq.destroy();
    } finally {
      await env.cleanup();
    }
  });
});

describe('Header Stripping', () => {
  it('should strip Origin and Referer headers when proxying to target', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      // The echo endpoint will return the headers it received
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost:8080',
          'Referer': 'http://localhost:8080/page',
          'X-Custom-Header': 'should-be-kept'
        },
        body: Buffer.from('{}')
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      const receivedHeaders = body.headers;
      
      // Origin and Referer should be stripped
      assert.ok(!receivedHeaders.origin, 'Origin header should be stripped');
      assert.ok(!receivedHeaders.referer, 'Referer header should be stripped');
      
      // Custom header should be kept
      assert.strictEqual(receivedHeaders['x-custom-header'], 'should-be-kept', 'Custom header should be kept');
      
      // Content-Type should be kept
      assert.ok(receivedHeaders['content-type'], 'Content-Type should be kept');
    } finally {
      await env.cleanup();
    }
  });

  it('should rewrite Host header to target port', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'GET',
        headers: {
          'Host': 'localhost:8080'  // Public tunnel port
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      const receivedHeaders = body.headers;
      
      // Host should be rewritten to target port
      assert.strictEqual(receivedHeaders.host, `localhost:${env.ports.targetPort}`, 
        'Host header should be rewritten to target port');
    } finally {
      await env.cleanup();
    }
  });
});

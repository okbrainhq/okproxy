// Test: CORS Support and Header Handling (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');
const { connect } = require('node:tls');
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');

describe('CORS Support', () => {
  it('should add CORS headers to successful response', async () => {
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
      // Check CORS headers are present
      assert.strictEqual(response.headers['access-control-allow-origin'], '*');
      assert.ok(response.headers['access-control-allow-methods'], 'Should have allow-methods header');
      assert.ok(response.headers['access-control-allow-headers'], 'Should have allow-headers header');
    } finally {
      await env.cleanup();
    }
  });

  it('should handle OPTIONS preflight request', async () => {
    const env = await createTestEnv();
    
    try {
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
      
      // Should return 204 No Content for preflight
      assert.strictEqual(response.statusCode, 204);
      // Should have CORS headers
      assert.strictEqual(response.headers['access-control-allow-origin'], '*');
      assert.ok(response.headers['access-control-allow-methods'].includes('POST'), 'Should allow POST');
    } finally {
      await env.cleanup();
    }
  });

  it('should add CORS headers to 502 error when no client', async () => {
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
      // CORS headers should be present even on errors
      assert.strictEqual(response.headers['access-control-allow-origin'], '*');
    } finally {
      await env.cleanup();
    }
  });

  it('should add CORS headers to 503 when max streams exceeded', async () => {
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
      assert.strictEqual(response.headers['access-control-allow-origin'], '*');
      
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

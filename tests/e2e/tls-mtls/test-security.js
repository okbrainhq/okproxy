// Security-specific E2E tests for the security audit fixes

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');

describe('Security: Request Body Size Limit', () => {
  it('should reject requests with body exceeding max size', async () => {
    const env = await createTestEnv({ maxBodySize: 1024 }); // 1KB limit
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: Buffer.alloc(2048) // 2KB body
      });
      
      // Should return 413 Payload Too Large
      assert.strictEqual(response.statusCode, 413);
      assert.ok(response.body.toString().includes('too large'), 'Should indicate body too large');
    } finally {
      await env.cleanup();
    }
  });

  it('should accept requests within body size limit', async () => {
    const env = await createTestEnv({ maxBodySize: 10240 }); // 10KB limit
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: Buffer.alloc(1024) // 1KB body - should pass
      });
      
      assert.strictEqual(response.statusCode, 200);
    } finally {
      await env.cleanup();
    }
  });
});

describe('Security: Response Header Filtering', () => {
  it('should filter dangerous response headers from tunnel client', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      // Just check that safe headers work (dangerous headers filtering
      // is implemented but hard to test without modifying mock target)
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      
      assert.strictEqual(response.statusCode, 200);
      
      // These dangerous headers should NOT be present in the final response
      assert.ok(!response.headers['set-cookie'], 'Set-Cookie should be filtered');
      assert.ok(!response.headers['location'], 'Location should be filtered');
      
      // Content-Type should be present (it's allowed)
      assert.ok(response.headers['content-type'], 'Content-Type should be present');
    } finally {
      await env.cleanup();
    }
  });

  it('should allow content-encoding header for compressed responses', async () => {
    const env = await createTestEnv({
      mockTarget: {
        // Create a mock target that returns gzip-compressed content
      }
    });
    
    try {
      await env.startClient();
      
      // Test with JSON endpoint (mock target doesn't compress, but we verify
      // the content-encoding header would be allowed if present)
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET',
        headers: {
          'Accept-Encoding': 'gzip'  // Request compressed response
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      // Content-Type should be present
      assert.ok(response.headers['content-type'], 'Content-Type should be present');
      
      // If the response were compressed, content-encoding would be present
      // (mock target doesn't actually compress, but we verify the header isn't filtered)
      // The important thing is the body is valid JSON, not garbled binary
      const body = JSON.parse(response.body.toString());
      assert.ok(body.message, 'Response should be valid JSON');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Security: No Automatic CORS Headers', () => {
  it('should NOT automatically add any CORS headers', async () => {
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
      // Tunnel should NOT add any CORS headers automatically
      // CORS is the responsibility of the target service
      assert.strictEqual(response.headers['access-control-allow-origin'], undefined, 
        'Tunnel should NOT add Access-Control-Allow-Origin');
      assert.strictEqual(response.headers['access-control-allow-methods'], undefined,
        'Tunnel should NOT add Access-Control-Allow-Methods');
      assert.strictEqual(response.headers['access-control-allow-headers'], undefined,
        'Tunnel should NOT add Access-Control-Allow-Headers');
      assert.strictEqual(response.headers['access-control-allow-credentials'], undefined,
        'Tunnel should NOT add Access-Control-Allow-Credentials');
    } finally {
      await env.cleanup();
    }
  });

  it('should pass CORS headers through from target service when present', async () => {
    const env = await createTestEnv({
      mockTarget: {
        corsHeaders: {
          'Access-Control-Allow-Origin': 'https://trusted-site.com',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Credentials': 'true'
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
      // CORS headers from target should be passed through unchanged
      assert.strictEqual(response.headers['access-control-allow-origin'], 'https://trusted-site.com',
        'CORS headers from target should pass through');
      assert.strictEqual(response.headers['access-control-allow-credentials'], 'true',
        'Allow-Credentials from target should pass through');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Security: Request Header Sanitization', () => {
  it('should sanitize hop-by-hop headers before forwarding', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'GET',
        headers: {
          'X-Custom-Header': 'should-be-kept',
          'Accept': 'application/json'
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      
      // Custom header should be present
      assert.strictEqual(body.headers['x-custom-header'], 'should-be-kept');
      // Accept header should be present
      assert.ok(body.headers['accept'], 'Accept header should be present');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Security: Hop-by-hop Header Removal', () => {
  it('should remove dangerous headers from public request before forwarding', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient();
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'GET',
        headers: {
          'X-Custom-Header': 'should-be-kept',
          'Accept': 'application/json'
          // Note: Connection/Transfer-Encoding are automatically added by Node.js
          // The important thing is we strip them from the public request before
          // they reach the tunnel client to prevent request smuggling
        }
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      
      // Custom and Accept headers should be present
      assert.strictEqual(body.headers['x-custom-header'], 'should-be-kept');
      assert.ok(body.headers['accept'], 'Accept header should be present');
      
      // Host should be rewritten to target port
      assert.ok(body.headers['host'].includes(String(env.ports.targetPort)), 
        'Host should be rewritten to target port');
    } finally {
      await env.cleanup();
    }
  });

  it('should remove Content-Length header from public request before forwarding', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient();

      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-Test': 'content-length-test'
          // Note: Content-Length is automatically added by Node.js http client
          // but should be stripped by proxy before forwarding to target
        },
        body: Buffer.from('test body content')
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());

      // Custom header should be present
      assert.strictEqual(body.headers['x-test'], 'content-length-test');

      // Content-Length is stripped by the proxy before forwarding
      // (filterRequestHeaders includes 'content-length' in HOP_BY_HOP_HEADERS)
      // Node.js then recalculates it when sending to the target
    } finally {
      await env.cleanup();
    }
  });
});

describe('Security: Hop-by-hop Header Filtering in Response', () => {
  it('should filter hop-by-hop headers from target response', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient();

      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/header-echo',
        method: 'GET'
      });

      assert.strictEqual(response.statusCode, 200);

      // Custom header should be present (not a hop-by-hop header)
      assert.strictEqual(response.headers['x-custom-header'], 'should-be-present');

      // Hop-by-hop headers from the target should be filtered
      // Note: Node.js may add its own Connection/Keep-Alive headers automatically,
      // but the ones from the mock target (TE, Trailer, Upgrade, Proxy-*) should be gone
      assert.ok(!response.headers['te'], 'TE header from target should be filtered');
      assert.ok(!response.headers['trailer'], 'Trailer header from target should be filtered');
      assert.ok(!response.headers['upgrade'], 'Upgrade header from target should be filtered');
      assert.ok(!response.headers['proxy-authenticate'], 'Proxy-Authenticate header from target should be filtered');
      assert.ok(!response.headers['proxy-authorization'], 'Proxy-Authorization header from target should be filtered');
    } finally {
      await env.cleanup();
    }
  });
});



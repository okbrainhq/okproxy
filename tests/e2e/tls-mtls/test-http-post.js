// Test 5: Simple HTTP POST (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

function slowHttpPost(options, chunks, delayMs) {
  const { request } = require('node:http');

  return new Promise((resolve, reject) => {
    let timer = null;
    let index = 0;
    let settled = false;

    function finish(err, result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    }

    const req = request(options, (res) => {
      const responseChunks = [];
      res.on('data', chunk => responseChunks.push(chunk));
      res.on('end', () => finish(null, {
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(responseChunks)
      }));
      res.on('error', finish);
    });

    req.on('error', finish);

    function writeNext() {
      if (settled) return;
      if (index >= chunks.length) {
        req.end();
        return;
      }
      req.write(chunks[index++]);
      timer = setTimeout(writeNext, delayMs);
    }

    writeNext();
  });
}

describe('HTTP POST', () => {
  it('should proxy POST request body to target', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post');
      
      const requestBody = JSON.stringify({ foo: 'bar', num: 42 });
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: Buffer.from(requestBody)
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.method, 'POST');
      assert.strictEqual(body.path, '/echo');
      
      // Verify body was echoed
      const echoedBody = Buffer.from(body.body, 'base64').toString();
      assert.strictEqual(echoedBody, requestBody);
    } finally {
      await env.cleanup();
    }
  });

  it('should stream large POST body', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post-large');
      
      const largeBody = Buffer.alloc(100 * 1024, 'x'); // 100KB
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: largeBody
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      
      // Verify body was received completely
      const echoedBody = Buffer.from(body.body, 'base64');
      assert.strictEqual(echoedBody.length, largeBody.length);
    } finally {
      await env.cleanup();
    }
  });

  it('should reset stream timeout while a slow upload is still sending data', async () => {
    const env = await createTestEnv({ streamTimeout: 400 });

    try {
      await env.startClient('test-post-slow-upload');

      const chunks = Array.from({ length: 8 }, (_, i) => Buffer.alloc(1024, String(i)));
      const startedAt = Date.now();

      const response = await slowHttpPost({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      }, chunks, 100);

      assert.ok(Date.now() - startedAt > 600, 'Upload should run longer than the stream timeout');
      assert.strictEqual(response.statusCode, 200);

      const body = JSON.parse(response.body.toString());
      const echoedBody = Buffer.from(body.body, 'base64');
      assert.strictEqual(echoedBody.length, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    } finally {
      await env.cleanup();
    }
  });

  it('should handle POST with empty body', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-post-empty');
      
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/echo',
        method: 'POST'
      });
      
      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.method, 'POST');
    } finally {
      await env.cleanup();
    }
  });
});

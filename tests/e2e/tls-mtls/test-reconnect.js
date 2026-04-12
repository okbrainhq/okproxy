// Test 11: Client Reconnection (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

describe('Client Reconnection', () => {
  it('should reconnect automatically after disconnect', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient('test-reconnect');
      assert.ok(env.isClientConnected(), 'Should be connected initially');

      // Kill the TLS socket (simulates network failure)
      env.disconnectClient();
      await new Promise(r => setTimeout(r, 100));
      assert.ok(!env.isClientConnected(), 'Should be disconnected');

      // Wait for reconnection (with initial 1s delay + connection time)
      await new Promise(r => setTimeout(r, 2000));

      // Check via client manager that client is back
      assert.ok(env.clientManager.has('test-reconnect'), 'Client should be registered in manager');
    } finally {
      await env.cleanup();
    }
  });

  it('should complete INIT handshake on reconnect', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient('test-reconnect-init');
      assert.ok(env.isConnected(), 'Should complete INIT first time');

      // Kill socket and wait for reconnect
      env.disconnectClient();
      await new Promise(r => setTimeout(r, 2000));

      // Should be reconnected and registered
      assert.ok(env.clientManager.has('test-reconnect-init'), 'Should be reconnected');
    } finally {
      await env.cleanup();
    }
  });

  it('should work after reconnection', async () => {
    const env = await createTestEnv();

    try {
      await env.startClient('test-reconnect-works');

      // Kill socket and wait for reconnect
      env.disconnectClient();
      await new Promise(r => setTimeout(r, 2000));

      // Wait a bit more for full initialization
      await new Promise(r => setTimeout(r, 500));

      // Make a request
      const response = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body.toString());
      assert.strictEqual(body.message, 'hello world');
    } finally {
      await env.cleanup();
    }
  });
});

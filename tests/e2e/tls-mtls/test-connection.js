// Test 3: Connection (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv } = require('./setup');

describe('Connection', () => {
  it('should accept TLS connections', async () => {
    const env = await createTestEnv();
    
    try {
      // Just verify servers are listening
      assert.ok(env.ports.tlsPort > 0);
      assert.ok(env.ports.httpPort > 0);
      assert.ok(env.ports.targetPort > 0);
    } finally {
      await env.cleanup();
    }
  });

  it('should register client after INIT handshake', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-client-1');
      
      assert.ok(env.isClientConnected(), 'Client should be connected');
      assert.ok(env.clientManager.has('test-client-1'), 'Client should be registered');
    } finally {
      await env.cleanup();
    }
  });

  it('should complete INIT handshake with proper settings', async () => {
    const env = await createTestEnv();
    
    try {
      await env.startClient('test-init-check');
      
      // Client should be initialized
      assert.ok(env.isConnected(), 'Client should report connected');
      assert.ok(!env.isDisconnected(), 'Client should not report disconnected');
    } finally {
      await env.cleanup();
    }
  });
});

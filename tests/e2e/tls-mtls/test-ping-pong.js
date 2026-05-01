// Test 14: PING/PONG Timeout (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { createTestEnv, getCertPaths } = require('./setup');

describe('PING/PONG Keepalive', () => {
  it('should send PING and expect PONG', async () => {
    const env = await createTestEnv({
      keepaliveInterval: 500,
      keepaliveTimeout: 1000
    });
    
    try {
      await env.startClient('test-ping');
      
      // Wait for at least one PING/PONG cycle
      await new Promise(r => setTimeout(r, 800));
      
      // Connection should still be alive
      assert.ok(env.isClientConnected(), 'Connection should stay alive with PONG responses');
    } finally {
      await env.cleanup();
    }
  });

  it('should detect dead client when PONG not received', async () => {
    const env = await createTestEnv({
      keepaliveInterval: 200,
      keepaliveTimeout: 300
    });
    const certs = getCertPaths();
    
    try {
      // Create a client that doesn't respond to PING
      const { connect } = require('node:tls');
      const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
      
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      let connected = false;
      let disconnected = false;
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            interface: 'test-no-pong'
          })));
          
          setTimeout(() => {
            connected = true;
            // Don't respond to PING frames
          }, 300);
        });
        
        socket.on('data', (data) => {
          // Ignore PING frames - don't send PONG
        });
        
        socket.on('close', () => {
          disconnected = true;
          resolve();
        });
        
        setTimeout(resolve, 1500);
      });
      
      assert.ok(connected, 'Should connect initially');
      assert.ok(disconnected, 'Should be disconnected for not responding to PING');
    } finally {
      await env.cleanup();
    }
  });

  it('should clean up streams when client times out', async () => {
    const env = await createTestEnv({
      keepaliveInterval: 200,
      keepaliveTimeout: 300
    });
    const certs = getCertPaths();
    
    try {
      // Start client that won't respond to PING
      const { connect } = require('node:tls');
      const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
      
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            interface: 'test-timeout-cleanup'
          })));
          setTimeout(resolve, 300);
        });
      });
      
      // Verify client registered
      assert.ok(env.connectionPool.count > 0, 'Client should be registered');
      
      // Wait for timeout
      await new Promise(r => setTimeout(r, 1000));
      
      // Client should be cleaned up
      assert.ok(env.connectionPool.count === 0, 'Client should be unregistered after timeout');
    } finally {
      await env.cleanup();
    }
  });
});

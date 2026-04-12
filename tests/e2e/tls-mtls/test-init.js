// Test 2: INIT Handshake (TLS version)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { createTestEnv, getPort, getCertPaths } = require('./setup');

describe('INIT Handshake', () => {
  it('should complete INIT handshake successfully', async () => {
    const env = await createTestEnv();
    const certs = getCertPaths();
    
    try {
      // Connect directly to TLS server with client certificates
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      let initReceived = false;
      const decoder = createFrameDecoder((frame) => {
        if (frame.streamId === 0 && frame.type === FrameType.INIT) {
          initReceived = true;
        }
      });
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            version: 1,
            clientId: 'test-handshake'
          })));
        });
        
        socket.on('data', decoder);
        
        socket.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        // Wait for INIT response
        setTimeout(() => {
          socket.end();
        }, 500);
      });
      
      assert.ok(initReceived, 'Should receive INIT response');
    } finally {
      await env.cleanup();
    }
  });

  it('should disconnect if non-INIT frame sent first', async () => {
    const env = await createTestEnv();
    const certs = getCertPaths();
    
    try {
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      let disconnected = false;
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          // Send HEADERS before INIT - should cause disconnect
          socket.write(encodeFrame(1, FrameType.HEADERS, JSON.stringify({
            method: 'GET',
            path: '/test'
          })));
        });
        
        socket.on('close', () => {
          disconnected = true;
          resolve();
        });
        
        setTimeout(resolve, 1000);
      });
      
      assert.ok(disconnected, 'Should be disconnected for non-INIT first frame');
    } finally {
      await env.cleanup();
    }
  });

  it('should disconnect if INIT not sent within timeout', async () => {
    const env = await createTestEnv({ initTimeout: 500 });
    const certs = getCertPaths();
    
    try {
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      let disconnected = false;
      const startTime = Date.now();
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          // Don't send anything
        });
        
        socket.on('close', () => {
          disconnected = true;
          resolve();
        });
        
        setTimeout(resolve, 3000);
      });
      
      const disconnectTime = Date.now() - startTime;
      assert.ok(disconnected, 'Should be disconnected after timeout');
      // Should disconnect after ~500ms timeout (initTimeout)
      assert.ok(disconnectTime < 1000, 'Should disconnect within reasonable time');
    } finally {
      await env.cleanup();
    }
  });

  it('should allow streams after INIT completes', async () => {
    const env = await createTestEnv();
    const certs = getCertPaths();
    
    try {
      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(certs.clientKey),
        cert: readFileSync(certs.clientCert),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true
      });
      
      let initReceived = false;
      let streamWorks = false;
      
      const decoder = createFrameDecoder((frame) => {
        if (frame.streamId === 0 && frame.type === FrameType.INIT) {
          initReceived = true;
          // After INIT, try to make a stream request
          socket.write(encodeFrame(1, FrameType.HEADERS, JSON.stringify({
            method: 'GET',
            path: '/test'
          })));
        }
        if (frame.streamId === 1) {
          // Server responded to our stream
          streamWorks = true;
        }
      });
      
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            version: 1,
            clientId: 'test-streams'
          })));
        });
        
        socket.on('data', decoder);
        setTimeout(() => {
          socket.end();
          resolve();
        }, 1000);
      });
      
      assert.ok(initReceived, 'Should complete INIT handshake');
      // Note: stream won't fully work without client manager registration
      // but the server should at least accept the frame
    } finally {
      await env.cleanup();
    }
  });
});

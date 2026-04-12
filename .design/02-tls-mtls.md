# Design: TLS + Mutual TLS (mTLS) Authentication

## Overview

Add TLS encryption and mutual TLS authentication on top of the simple TCP tunnel from Phase 1. This transforms the insecure tunnel into a production-ready secure tunnel.

## Changes from Phase 1

| Aspect | Phase 1 (Simple TCP) | Phase 2 (TLS + mTLS) |
|--------|---------------------|---------------------|
| Transport | Plain TCP socket (`node:net`) | TLS-encrypted socket (`node:tls`) |
| Authentication | None | Certificate-based mutual auth |
| Client Identity | Single client, no identity | Single client, validated by certificate |
| Server Config | Port only | Port + server cert + CA cert |
| Client Config | Server host/port | Server host/port + client cert + CA cert |
| Security | None | Full encryption + identity verification |

## Architecture

```
HTTP Client
     │
     │ HTTP (or HTTPS via Caddy in Phase 3)
     ▼
┌──────────────────────────────────────┐
│     Public HTTP Server (Node.js)     │
│      Routes to single tunnel client  │
│      ( whichever client is connected)│
└──────────────┬───────────────────────┘
               │
               │ For each HTTP request:
               │ → assign streamId
               │ → send via TLS socket
               ▼
┌──────────────────────────────────────┐
│      TLS Server (node:tls)           │
│                                      │
│  Server config:                      │
│  • key: server-key.pem               │
│  • cert: server-cert.pem             │
│  • ca: ca-cert.pem                   │
│  • requestCert: true                 │
│  • rejectUnauthorized: true          │
│                                      │
│  Validates:                          │
│  1. Client cert signed by CA         │
│  2. Certificate not expired          │
│  3. Certificate not revoked          │
└──────────────┬───────────────────────┘
               │ TLS-encrypted TCP
               │ (mutual certificate exchange)
               ▼
┌──────────────────────────────────────┐
│      TLS Client (node:tls)           │
│                                      │
│  Client config:                      │
│  • key: client-key.pem               │
│  • cert: client-cert.pem             │
│  • ca: ca-cert.pem                   │
│  • rejectUnauthorized: true          │
│                                      │
│  Validates server certificate        │
└──────────────┬───────────────────────┘
               │
               │ Proxies to localhost
               ▼
         Target Service
```

## Framing Protocol

**Same exact framing protocol as Phase 1** - no changes needed:

```
┌─────────────────┬───────────┬─────────────────┬──────────────────┐
│  Stream ID      │  Type     │  Length         │  Payload         │
│  (4 bytes)      │  (1 byte) │  (4 bytes)      │  (N bytes)       │
└─────────────────┴───────────┴─────────────────┴──────────────────┘
```

**Frame Types (unchanged from Phase 1):**
- `0x01` HEADERS
- `0x02` DATA
- `0x03` FIN
- `0x04` ERROR
- `0x05` INIT (connection handshake)
- `0x06` PING
- `0x07` PONG

The framing protocol sits on top of TLS - TLS handles the encryption, our protocol handles the multiplexing. PING/PONG keepalive, stream timeouts, MAX_FRAME_SIZE, backpressure, and concurrent stream limits from Phase 1 all apply unchanged on the TLS socket.

## Connection Sequence

```
1. TCP connect
2. TLS handshake (mutual certificate exchange)
   → Server validates client cert (CA-signed, not expired, not revoked)
   → Client validates server cert
3. INIT frame exchange (protocol version, maxFrameSize negotiation)
4. Ready for streams
```

The server maintains the single-client model from Phase 1. Only one client can be connected at a time. The TLS layer adds authentication - the server verifies the client's certificate before allowing the INIT handshake to proceed.

## Components

### 1. Certificate Authority (CA)

**Location:** `/apps/server/lib/ca.js`

**Responsibilities:**
- Generate CA key pair (RSA 2048)
- Self-sign CA certificate
- Issue/sign client certificates
- Issue server certificates
- Manage certificate revocation

**Implementation (using OpenSSL CLI):**
```javascript
const { execSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');

const CA_DIR = './data/ca';

function initCA(caDir = CA_DIR) {
  if (!existsSync(caDir)) mkdirSync(caDir, { recursive: true });
  
  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');
  
  // Generate CA private key
  execSync(`openssl genrsa -out "${caKeyPath}" 2048`, { stdio: 'pipe' });
  chmodSync(caKeyPath, 0o600);
  
  // Self-sign CA certificate (valid for 10 years)
  execSync(
    `openssl req -x509 -new -key "${caKeyPath}" -out "${caCertPath}" -days 3650 -subj "/CN=Tunnel-CA"`,
    { stdio: 'pipe' }
  );
  
  // Initialize tracking files
  writeFileSync(join(caDir, 'crl.txt'), '');
  writeFileSync(join(caDir, 'issued.txt'), '');
  writeFileSync(join(caDir, 'serial-counter.txt'), '1');
  
  console.log('CA initialized');
  return { caCertPath, caKeyPath };
}

function issueClientCertificate(clientId, outputDir, caDir = CA_DIR) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  
  const serial = getNextSerial(caDir);
  
  const clientKeyPath = join(outputDir, 'client-key.pem');
  const clientCertPath = join(outputDir, 'client-cert.pem');
  const clientCsrPath = join(outputDir, 'client.csr');
  
  // Generate client private key
  execSync(`openssl genrsa -out "${clientKeyPath}" 2048`, { stdio: 'pipe' });
  chmodSync(clientKeyPath, 0o600);
  
  // Create CSR with clientId as CN
  execSync(
    `openssl req -new -key "${clientKeyPath}" -out "${clientCsrPath}" -subj "/CN=${clientId}"`,
    { stdio: 'pipe' }
  );
  
  // Sign certificate with CA (valid for 90 days)
  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');
  execSync(
    `openssl x509 -req -in "${clientCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -out "${clientCertPath}" -days 90 -set_serial ${serial}`,
    { stdio: 'pipe' }
  );
  
  // Copy CA cert and cleanup
  execSync(`cp "${caCertPath}" "${join(outputDir, 'ca-cert.pem')}"`);
  execSync(`rm "${clientCsrPath}"`);
  
  // Track issued certificate
  appendFileSync(join(caDir, 'issued.txt'), `${serial}\t${clientId}\t${new Date().toISOString()}\n`);
  
  return { serial, clientId, certPath: clientCertPath, keyPath: clientKeyPath };
}

function issueServerCertificate(hostname, outputDir, caDir = CA_DIR) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  
  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');
  
  const serverKeyPath = join(outputDir, 'server-key.pem');
  const serverCertPath = join(outputDir, 'server-cert.pem');
  const serverCsrPath = join(outputDir, 'server.csr');
  const tempConfig = join(outputDir, '.openssl.cnf');
  
  // Generate server private key
  execSync(`openssl genrsa -out "${serverKeyPath}" 2048`, { stdio: 'pipe' });
  chmodSync(serverKeyPath, 0o600);
  
  // Create temp config for SAN extension
  const sanExt = hostname.includes(':') || /^\d+$/.test(hostname.replace(/\./g, ''))
    ? `IP:${hostname}`
    : `DNS:${hostname}`;
  writeFileSync(tempConfig, `[req]\ndistinguished_name=dn\n[dn]\n[SAN]\nsubjectAltName=${sanExt}\n`);
  
  // Create CSR with SAN
  execSync(
    `openssl req -new -key "${serverKeyPath}" -out "${serverCsrPath}" -subj "/CN=${hostname}" -config "${tempConfig}" -reqexts SAN`,
    { stdio: 'pipe' }
  );
  
  // Sign certificate with CA (valid for 1 year)
  execSync(
    `openssl x509 -req -in "${serverCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -out "${serverCertPath}" -days 365 -extfile "${tempConfig}" -extensions SAN`,
    { stdio: 'pipe' }
  );
  
  // Cleanup
  execSync(`rm "${serverCsrPath}" "${tempConfig}"`);
  
  return { hostname, certPath: serverCertPath, keyPath: serverKeyPath };
}

function revokeCertificate(serial, caDir = CA_DIR) {
  appendFileSync(join(caDir, 'crl.txt'), `${serial}\n`);
}

function isRevoked(serial, caDir = CA_DIR) {
  const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
  return crl.split('\n').includes(String(serial));
}

function getNextSerial(caDir = CA_DIR) {
  const counterPath = join(caDir, 'serial-counter.txt');
  const counter = parseInt(readFileSync(counterPath, 'utf8'), 10);
  writeFileSync(counterPath, String(counter + 1));
  return counter;
}

function listCertificates(caDir = CA_DIR) {
  const issued = readFileSync(join(caDir, 'issued.txt'), 'utf8');
  const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
  const revokedSerials = new Set(crl.split('\n').filter(Boolean));
  
  return issued.split('\n').filter(Boolean).map(line => {
    const [serial, clientId, issuedAt] = line.split('\t');
    return {
      serial: parseInt(serial, 10),
      clientId,
      issuedAt,
      revoked: revokedSerials.has(serial)
    };
  });
}
```

**Key Design Decision: Revocation by Serial Number**

Revoking by CN would invalidate all certificates for a client (problematic during key rotation). Instead:
- Each certificate gets a unique serial number from an auto-incrementing counter.
- `issued.txt` tracks `serial\tclientId\tissuedAt` per certificate.
- Revocation targets a specific serial, allowing old and new certs to coexist during rotation.

### 2. Server Updates

**New File:** `/apps/server/lib/tls-server.js`

```javascript
const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { isRevoked } = require('./ca');

const KEEPALIVE_INTERVAL = 30000;
const KEEPALIVE_TIMEOUT = 10000;
const INIT_TIMEOUT = 10000;
const MAX_CONCURRENT_STREAMS = 100;

function createTLSServer(clientManager, options = {}) {
  const maxStreams = options.maxConcurrentStreams || MAX_CONCURRENT_STREAMS;
  const keepaliveInterval = options.keepaliveInterval || KEEPALIVE_INTERVAL;
  const keepaliveTimeout = options.keepaliveTimeout || KEEPALIVE_TIMEOUT;
  const initTimeout = options.initTimeout || INIT_TIMEOUT;
  
  const tlsOptions = {
    key: readFileSync(options.serverKey),
    cert: readFileSync(options.serverCert),
    ca: readFileSync(options.caCert),
    requestCert: true,
    rejectUnauthorized: true
  };
  
  let nextStreamId = 1;
  
  const server = createServer(tlsOptions, (socket) => {
    // TLS authentication check
    if (!socket.authorized) {
      console.error('TLS auth failed:', socket.authorizationError);
      socket.destroy();
      return;
    }
    
    // Check certificate revocation
    const cert = socket.getPeerCertificate();
    const serial = cert.serialNumber;
    
    if (isRevoked(serial, options.caDir || './data/ca')) {
      console.error('Client certificate revoked, serial:', serial);
      socket.destroy();
      return;
    }
    
    console.log('TLS client connected, serial:', serial);
    
    let initialized = false;
    let initTimer = null;
    let keepaliveTimer = null;
    let keepaliveDeadline = null;

    function sendPing() {
      if (!initialized || socket.destroyed) return;
      socket.write(encodeFrame(0, FrameType.PING, Buffer.alloc(0)));
      keepaliveDeadline = Date.now() + keepaliveTimeout;
    }

    function startKeepalive() {
      keepaliveTimer = setInterval(() => {
        if (keepaliveDeadline && Date.now() > keepaliveDeadline) {
          socket.destroy();
          return;
        }
        if (!keepaliveDeadline) sendPing();
      }, keepaliveInterval);
    }

    function stopKeepalive() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    const decoder = createFrameDecoder(
      (frame) => {
        if (!initialized) {
          // Must receive INIT first
          if (frame.streamId !== 0 || frame.type !== FrameType.INIT) {
            socket.destroy();
            return;
          }

          try {
            if (initTimer) {
              clearTimeout(initTimer);
              initTimer = null;
            }

            // Send INIT ACK
            socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
              version: 1,
              maxFrameSize: 1048576,
              maxConcurrentStreams: maxStreams
            })));

            // Register client (single client model)
            clientManager.add({
              socket,
              write: (data) => socket.write(data),
              activeStreams: new Map()
            });

            initialized = true;
            startKeepalive();
            return;
          } catch (err) {
            socket.destroy();
            return;
          }
        }

        // Handle PONG
        if (frame.streamId === 0 && frame.type === FrameType.PONG) {
          keepaliveDeadline = null;
          return;
        }

        // Handle client responses
        if (frame.streamId > 0) {
          const handler = clientManager.getStreamHandler(frame.streamId);
          if (handler) {
            if (frame.type === FrameType.ERROR && handler.errorHandler) {
              handler.errorHandler(new Error(frame.payload.toString()));
            } else if (handler.frameHandler) {
              handler.frameHandler(frame);
            }
          }
        }
      },
      (err) => {
        console.error('Protocol error:', err.message);
        socket.destroy();
      }
    );

    socket.on('data', decoder);
    
    socket.on('close', () => {
      stopKeepalive();
      if (initTimer) clearTimeout(initTimer);
      if (clientManager.get() && clientManager.get().socket === socket) {
        clientManager.remove();
      }
    });

    socket.on('error', (err) => {
      const ignoreCodes = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT'];
      if (!ignoreCodes.includes(err.code)) {
        console.error('Socket error:', err.message || err.code);
      }
      socket.destroy();
    });

    // INIT timeout
    initTimer = setTimeout(() => {
      if (!initialized) socket.destroy();
    }, initTimeout);
  });

  server.allocateStreamId = () => {
    const id = nextStreamId++;
    if (nextStreamId > 2147483647) nextStreamId = 1;
    return id;
  };

  return server;
}

module.exports = { createTLSServer };
```

**Key Differences from Phase 1:**
1. Use `node:tls` instead of `node:net`
2. Validate `socket.authorized` - rejects if client cert fails TLS validation
3. Check certificate revocation list by serial number
4. Same single-client model as Phase 1
5. INIT handshake, PING/PONG, MAX_FRAME_SIZE, backpressure, stream timeouts all carry over unchanged

**Server index.js updates:**

Add TLS mode option (keep TCP as default for backward compatibility):

```javascript
function parseArgs() {
  const options = {
    httpPort: 8080,
    tcpPort: 9000,           // Keep for backward compatibility
    tlsPort: null,           // Enable TLS mode when set
    // ... other options
  };
  
  // Add new CLI args:
  // --tls-port <port>     Enable TLS mode on this port
  // --key <path>          Server private key
  // --cert <path>         Server certificate
  // --ca <path>           CA certificate for client verification
  // --ca-dir <path>       CA directory for revocation checks (default: ./data/ca)
}

function main() {
  // ...
  
  // Choose between TCP and TLS server
  let tunnelServer;
  if (options.tlsPort) {
    tunnelServer = createTLSServer(clientManager, options);
    tunnelServer.listen(options.tlsPort, () => {
      console.log(`TLS tunnel server listening on port ${options.tlsPort}`);
    });
  } else {
    tunnelServer = createTCPServer(clientManager, options);
    tunnelServer.listen(options.tcpPort, () => {
      console.log(`TCP tunnel server listening on port ${options.tcpPort}`);
    });
  }
  
  // HTTP server uses tunnelServer for stream ID allocation
  const httpServer = createHTTPServer(clientManager, tunnelServer, options);
}
```

### 3. Client Updates

**Updated File:** `/apps/client/lib/tls-connection.js` (new file, or update connection.js to support TLS)

```javascript
const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

function createTLSConnection(config, onFrame, onConnect, onDisconnect) {
  let socket = null;
  let decoder = null;
  let initialized = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer = null;
  let destroyed = false;

  function connectToServer() {
    if (destroyed) return;

    const tlsOptions = {
      host: config.serverHost,
      port: config.serverPort,
      key: readFileSync(config.clientKey),
      cert: readFileSync(config.clientCert),
      ca: readFileSync(config.caCert),
      rejectUnauthorized: true
    };

    socket = connect(tlsOptions, () => {
      console.log('TLS connected to server');
      console.log('Server certificate valid:', socket.authorized);
      
      // Send INIT handshake after TLS handshake completes
      socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
        version: 1,
        maxFrameSize: 1048576
      })));
    });

    initialized = false;

    decoder = createFrameDecoder(
      (frame) => {
        if (!initialized) {
          if (frame.streamId === 0 && frame.type === FrameType.INIT) {
            initialized = true;
            reconnectDelay = INITIAL_RECONNECT_DELAY;
            if (onConnect) onConnect();
            return;
          }
          socket.destroy();
          return;
        }

        // Handle PING
        if (frame.streamId === 0 && frame.type === FrameType.PING) {
          socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          return;
        }

        if (onFrame) onFrame(frame);
      },
      (err) => {
        console.error('Protocol error:', err.message);
        socket.destroy();
      }
    );

    socket.on('data', decoder);

    socket.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
        console.error('TLS error:', err.message);
      }
    });

    socket.on('close', () => {
      initialized = false;
      if (onDisconnect) onDisconnect();
      if (!destroyed) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToServer();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function write(data) {
    if (socket && !socket.destroyed && initialized) {
      return socket.write(data);
    }
    return false;
  }

  function destroy() {
    destroyed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) socket.destroy();
  }

  connectToServer();

  return { write, destroy, isConnected: () => socket && !socket.destroyed && initialized };
}

module.exports = { createTLSConnection };
```

**Key Differences from Phase 1:**
1. Use `node:tls` instead of `node:net`
2. Provide client certificate in TLS options
3. Verify server certificate (`rejectUnauthorized: true`)
4. Send INIT handshake after TLS connection is established
5. Handle PING/PONG in connection layer (moved from proxy.js)

**Client index.js updates:**

```javascript
function parseArgs() {
  const options = {
    serverHost: 'localhost',
    serverPort: 9000,
    targetHost: 'localhost',
    targetPort: 3000,
    // TLS options (required for TLS mode)
    clientKey: null,
    clientCert: null,
    caCert: null
  };
  
  // Add new CLI args:
  // --key <path>      Client private key
  // --cert <path>     Client certificate
  // --ca <path>       CA certificate to verify server
}

function main() {
  const config = parseArgs();
  
  // Choose between TCP and TLS connection
  const useTLS = config.clientKey && config.clientCert && config.caCert;
  
  if (useTLS) {
    const { createTLSConnection } = require('./lib/tls-connection');
    connection = createTLSConnection(config, onFrame, onConnect, onDisconnect);
  } else {
    const { createConnection } = require('./lib/connection');
    connection = createConnection(config, onFrame, onConnect, onDisconnect);
  }
}
```

### 4. Certificate CLI Tool

**File:** `/apps/server/bin/tunnel-ca.js`

```javascript
#!/usr/bin/env node

const { initCA, issueClientCertificate, issueServerCertificate, revokeCertificate, listCertificates } = require('../lib/ca');

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'init':
      initCA();
      break;
      
    case 'issue':
      const clientIdIdx = args.indexOf('--client-id');
      const outputIdx = args.indexOf('--output');
      const caDirIdx = args.indexOf('--ca-dir');
      
      if (clientIdIdx === -1) {
        console.error('Usage: tunnel-ca.js issue --client-id <id> --output <dir> [--ca-dir <dir>]');
        process.exit(1);
      }
      
      issueClientCertificate(
        args[clientIdIdx + 1],
        outputIdx !== -1 ? args[outputIdx + 1] : './certs',
        caDirIdx !== -1 ? args[caDirIdx + 1] : './data/ca'
      );
      break;
      
    case 'issue-server':
      const hostnameIdx = args.indexOf('--hostname');
      const serverOutputIdx = args.indexOf('--output');
      
      if (hostnameIdx === -1) {
        console.error('Usage: tunnel-ca.js issue-server --hostname <name> --output <dir>');
        process.exit(1);
      }
      
      issueServerCertificate(
        args[hostnameIdx + 1],
        serverOutputIdx !== -1 ? args[serverOutputIdx + 1] : './certs'
      );
      break;
      
    case 'revoke':
      const serialIdx = args.indexOf('--serial');
      if (serialIdx === -1) {
        console.error('Usage: tunnel-ca.js revoke --serial <number>');
        process.exit(1);
      }
      revokeCertificate(parseInt(args[serialIdx + 1], 10));
      break;
      
    case 'list':
      const certs = listCertificates();
      console.table(certs);
      break;
      
    default:
      console.log(`
Usage: tunnel-ca.js <command> [options]

Commands:
  init                          Initialize CA
  issue --client-id <id>        Issue client certificate
          --output <dir>        Output directory
          --ca-dir <dir>        CA directory (default: ./data/ca)
  issue-server --hostname <h>   Issue server certificate
               --output <dir>   Output directory
  revoke --serial <number>      Revoke certificate
  list                          List all certificates
      `);
  }
}

if (require.main === module) {
  main();
}
```

## Certificate Structure

### CA Certificate
```
Subject: CN=Tunnel-CA
Issuer: CN=Tunnel-CA (self-signed)
Valid: 10 years
Key: RSA 2048
Usage: Certificate signing
```

### Server Certificate
```
Subject: CN=localhost (or server hostname)
Issuer: CN=Tunnel-CA
Valid: 1 year
Key: RSA 2048
Usage: TLS server authentication
SAN: DNS:localhost,IP:127.0.0.1 (for local testing)
```

### Client Certificate
```
Subject: CN=<client-id> (any identifier)
Issuer: CN=Tunnel-CA
Valid: 90 days
Key: RSA 2048
Usage: TLS client authentication
Serial: Tracked for revocation
```

## Certificate Rotation

Client certificates expire after 90 days. Rotation without downtime:

1. **Issue new certificate** with the same or different CN but a new serial number: `tunnel-ca.js issue --client-id myapp`
2. **Deploy new cert** to the client (file replacement or side-by-side).
3. **Client reconnects** with the new certificate. The old certificate remains valid until expiry or manual revocation.
4. **Revoke old certificate** (optional): `tunnel-ca.js revoke --serial <old-serial>`

Both old and new certificates are valid simultaneously during the overlap period. This is safe because revocation is by serial number, not CN.

**Recommended rotation schedule:**
- Issue new cert at day 75 (15 days before expiry).
- Revoke old cert at day 90 or after confirming new cert is active.

## Prerequisites

Phase 2 requires the `openssl` CLI tool available in `$PATH` for certificate management operations (CA init, cert issuance, revocation). This is a runtime dependency for the `tunnel-ca.js` CLI tool only — the server and client themselves do not call openssl at runtime.

## HTTP Router

**No changes from Phase 1.** The HTTP router continues to route to the single connected client:

```javascript
function createHTTPServer(clientManager, tunnelServer, options) {
  const server = createServer((req, res) => {
    const client = clientManager.get();
    
    if (!client) {
      res.statusCode = 502;
      res.end('Tunnel client not connected');
      return;
    }
    
    const streamId = tunnelServer.allocateStreamId();
    // ... rest same as Phase 1
  });
}
```

The authentication happens at the TLS layer before the HTTP router is involved. Only authenticated clients can connect and be registered with the `ClientManager`.

## End-to-End Tests

**Location:** `/tests/e2e/tls-mtls/`

### Test Setup

```javascript
// setup.js - Generate test certificates
const { execSync } = require('child_process');
const { mkdirSync } = require('fs');

function setupTLSTests() {
  const testCertsDir = './test-certs';
  mkdirSync(testCertsDir, { recursive: true });
  
  // Generate test CA
  execSync(`openssl genrsa -out ${testCertsDir}/ca-key.pem 2048`);
  execSync(`openssl req -x509 -new -key ${testCertsDir}/ca-key.pem -out ${testCertsDir}/ca-cert.pem -days 1 -subj "/CN=Test-CA"`);
  
  // Generate valid client cert (serial 100)
  execSync(`openssl genrsa -out ${testCertsDir}/client-key.pem 2048`);
  execSync(`openssl req -new -key ${testCertsDir}/client-key.pem -out ${testCertsDir}/client.csr -subj "/CN=test-client"`);
  execSync(`openssl x509 -req -in ${testCertsDir}/client.csr -CA ${testCertsDir}/ca-cert.pem -CAkey ${testCertsDir}/ca-key.pem -out ${testCertsDir}/client-cert.pem -days 1 -set_serial 100`);
  
  // Generate server cert with SAN
  execSync(`openssl genrsa -out ${testCertsDir}/server-key.pem 2048`);
  execSync(`openssl req -new -key ${testCertsDir}/server-key.pem -out ${testCertsDir}/server.csr -subj "/CN=localhost"`);
  // Create config for SAN
  const fs = require('fs');
  fs.writeFileSync(`${testCertsDir}/extfile.cnf`, 'subjectAltName=DNS:localhost,IP:127.0.0.1');
  execSync(`openssl x509 -req -in ${testCertsDir}/server.csr -CA ${testCertsDir}/ca-cert.pem -CAkey ${testCertsDir}/ca-key.pem -out ${testCertsDir}/server-cert.pem -days 1 -extfile ${testCertsDir}/extfile.cnf`);
  
  return {
    caCert: `${testCertsDir}/ca-cert.pem`,
    serverKey: `${testCertsDir}/server-key.pem`,
    serverCert: `${testCertsDir}/server-cert.pem`,
    clientKey: `${testCertsDir}/client-key.pem`,
    clientCert: `${testCertsDir}/client-cert.pem`
  };
}
```

### Test Cases

#### Test 1: TLS Handshake Success
```javascript
// Start TLS server with CA
// Connect client with valid cert
// Assert: socket.authorized === true
// Assert: INIT handshake completes
```

#### Test 2: Client Without Certificate
```javascript
// Start TLS server (requestCert: true)
// Connect client without client cert
// Assert: Connection rejected during handshake
```

#### Test 3: Client With Invalid Certificate (Wrong CA)
```javascript
// Generate cert signed by different CA
// Try to connect
// Assert: Connection rejected (unauthorized)
```

#### Test 4: Server Certificate Validation (Client-side)
```javascript
// Start server with cert signed by CA A
// Client has CA cert for CA B
// Assert: Client rejects server (error on connect)
```

#### Test 5: Revoked Certificate
```javascript
// Issue valid cert
// Connect successfully
// Revoke certificate
// Disconnect client
// Try to reconnect
// Assert: Connection rejected (revoked)
```

#### Test 6: HTTP Request Over mTLS
```javascript
// Setup server + client with valid mTLS
// Mock target returns data
// Make HTTP GET
// Assert: Response received correctly
```

#### Test 7: Streaming Over mTLS
```javascript
// Setup server + client
// Mock streams data
// Make HTTP request
// Assert: Streaming works (chunks arrive progressively)
```

#### Test 8: SSE Over mTLS
```javascript
// Setup server + client
// Mock is SSE endpoint
// Connect with EventSource
// Assert: SSE events received
```

#### Test 9: TLS with Backpressure
```javascript
// Setup server + client
// Mock target processes slowly
// Send large streaming request
// Assert: Backpressure applied, no memory growth
```

#### Test 10: TLS Keepalive (PING/PONG)
```javascript
// Setup server + client
// Wait for server to send PING
// Assert: Client responds with PONG
// Assert: Connection stays alive
```

## Directory Structure

```
/packages/
  /frame-protocol/
    index.js           # Shared encoder/decoder (from Phase 1)
    package.json
/apps/
  /server/
    index.js           # Entry point with TLS/TCP mode selection
    lib/
      tcp-server.js    # Plain TCP (from Phase 1, unchanged)
      tls-server.js    # NEW: TLS version
      http-router.js   # Unchanged from Phase 1
      client-manager.js # Unchanged from Phase 1 (single client)
      ca.js            # NEW: Certificate authority
    bin/
      tunnel-ca.js     # NEW: CLI for cert management
    data/
      ca/              # CA files (gitignored)
        ca-key.pem
        ca-cert.pem
        crl.txt
        issued.txt
        serial-counter.txt
    certs/             # Server TLS certs
      server-key.pem
      server-cert.pem
    package.json
  /client/
    index.js           # Entry point with TLS/TCP selection
    lib/
      connection.js    # Plain TCP (from Phase 1, unchanged)
      tls-connection.js # NEW: TLS version
      proxy.js         # Unchanged from Phase 1
    package.json
/tests/
  /e2e/
    /simple-tcp/       # Phase 1 tests (unchanged)
    /tls-mtls/         # NEW: Phase 2 tests
      setup.js
      teardown.js
      test-tls-handshake.js
      test-no-cert.js
      test-wrong-ca.js
      test-revoked.js
      test-http.js
      test-streaming.js
      test-sse.js
      test-backpressure.js
      test-keepalive.js
      run.js
/package.json
```

## Running

```bash
# 1. Initialize CA (one time)
node apps/server/bin/tunnel-ca.js init

# 2. Issue server certificate
node apps/server/bin/tunnel-ca.js issue-server --hostname localhost --output ./apps/server/certs/

# 3. Issue client certificate
node apps/server/bin/tunnel-ca.js issue --client-id myapp --output ./certs/myapp/

# 4. Start server in TLS mode
node apps/server/index.js --http-port 8080 --tls-port 9443 \
  --key ./apps/server/certs/server-key.pem \
  --cert ./apps/server/certs/server-cert.pem \
  --ca ./data/ca/ca-cert.pem

# 5. Start target service
python -m http.server 3000

# 6. Start client with TLS certificates
node apps/client/index.js --server localhost:9443 --target localhost:3000 \
  --key ./certs/myapp/client-key.pem \
  --cert ./certs/myapp/client-cert.pem \
  --ca ./certs/myapp/ca-cert.pem

# 7. Test (HTTP router unchanged from Phase 1)
curl http://localhost:8080/test
```

**Note:** In Phase 2, the HTTP router still passes the full URL path to the client (same as Phase 1). The client certificate identifies the client to the server during TLS handshake, but routing is still "whichever client is currently connected."

## Verification Checklist

- [ ] CA initialization works
- [ ] Client certificate issuance works
- [ ] Server certificate issuance works (with SAN)
- [ ] TLS server starts and accepts connections
- [ ] Client connects with valid certificate
- [ ] Client rejected without certificate
- [ ] Client rejected with wrong-CA certificate
- [ ] Server certificate validated by client
- [ ] Client rejected when server has wrong certificate
- [ ] Client rejected with revoked certificate
- [ ] HTTP requests work over mTLS
- [ ] Streaming works over mTLS
- [ ] SSE works over mTLS
- [ ] Backpressure works over TLS
- [ ] PING/PONG keepalive works over TLS
- [ ] INIT handshake completes after TLS handshake
- [ ] All Phase 1 e2e tests still pass in TCP mode
- [ ] All Phase 2 e2e tests pass in TLS mode

## Security Checklist

- [ ] CA private key protected (chmod 600)
- [ ] Server validates client certificates (`requestCert: true, rejectUnauthorized: true`)
- [ ] Client validates server certificate (`rejectUnauthorized: true`)
- [ ] Revocation list checked on connection
- [ ] Certificate expiry enforced by TLS layer
- [ ] Strong TLS version (1.2+) and ciphers (Node.js defaults)
- [ ] MAX_FRAME_SIZE enforced before allocating memory
- [ ] Stream count limits enforced
- [ ] INIT handshake required (no streams before init)
- [ ] Keepalive timeout detects dead connections
- [ ] Stream inactivity timeout prevents hanging streams

#!/usr/bin/env node
// Server Entry Point - TLS + mTLS only

const { createTLSServer } = require('./lib/tls-server');
const { createHTTPServer } = require('./lib/http-router');
const { ClientManager } = require('./lib/client-manager');

const DEFAULT_KEY = './.certs/server-key.pem';
const DEFAULT_CERT = './.certs/server-cert.pem';
const DEFAULT_CA = './.ca/ca-cert.pem';
const DEFAULT_CA_DIR = './.ca';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    httpPort: 8080,
    tlsPort: 9443,
    serverKey: DEFAULT_KEY,
    serverCert: DEFAULT_CERT,
    caCert: DEFAULT_CA,
    caDir: DEFAULT_CA_DIR,
    maxConcurrentStreams: 100,
    streamTimeout: 30000,
    keepaliveInterval: 10000,
    keepaliveTimeout: 15000
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--http-port':
        const httpPort = parseInt(args[++i], 10);
        if (httpPort < 1 || httpPort > 65535) {
          console.error(`Error: Invalid HTTP port ${httpPort}. Must be 1-65535.`);
          process.exit(1);
        }
        options.httpPort = httpPort;
        break;
      case '--tls-port':
        const tlsPort = parseInt(args[++i], 10);
        if (tlsPort < 1 || tlsPort > 65535) {
          console.error(`Error: Invalid TLS port ${tlsPort}. Must be 1-65535.`);
          process.exit(1);
        }
        options.tlsPort = tlsPort;
        break;
      case '--key':
        options.serverKey = args[++i];
        break;
      case '--cert':
        options.serverCert = args[++i];
        break;
      case '--ca':
        options.caCert = args[++i];
        break;
      case '--ca-dir':
        options.caDir = args[++i];
        break;
      case '--max-streams':
        options.maxConcurrentStreams = parseInt(args[++i], 10);
        break;
      case '--stream-timeout':
        options.streamTimeout = parseInt(args[++i], 10);
        break;
      case '--keepalive-interval':
        options.keepaliveInterval = parseInt(args[++i], 10);
        break;
      case '--keepalive-timeout':
        options.keepaliveTimeout = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Usage: node index.js [options]

Options:
  --http-port <port>          HTTP server port (default: 8080)
  --tls-port <port>           TLS tunnel port (default: 9443)
  --key <path>                Server private key (default: ${DEFAULT_KEY})
  --cert <path>               Server certificate (default: ${DEFAULT_CERT})
  --ca <path>                 CA certificate for client verification (default: ${DEFAULT_CA})
  --ca-dir <path>             CA directory for revocation checks (default: ${DEFAULT_CA_DIR})
  --max-streams <n>           Max concurrent streams per client (default: 100)
  --stream-timeout <ms>       Stream inactivity timeout (default: 30000)
  --keepalive-interval <ms>   PING interval (default: 10000)
  --keepalive-timeout <ms>    PONG timeout (default: 15000)
  --help                      Show this help

Examples:
  # With default certificate paths
  node apps/server/index.js

  # With custom certificate paths
  node apps/server/index.js \\
    --key ./certs/server-key.pem \\
    --cert ./certs/server-cert.pem \\
    --ca ./.ca/ca-cert.pem
        `);
        process.exit(0);
    }
  }

  return options;
}

function main() {
  const options = parseArgs();

  console.log('Starting TLS tunnel server...');
  console.log('Options:', options);

  const clientManager = new ClientManager();

  // Create TLS server
  const tlsServer = createTLSServer(clientManager, options);

  // Create HTTP server for public requests
  const httpServer = createHTTPServer(clientManager, tlsServer, options);

  // Start TLS server
  tlsServer.listen(options.tlsPort, () => {
    console.log(`TLS tunnel server listening on port ${options.tlsPort}`);
  });

  // Start HTTP server
  httpServer.listen(options.httpPort, () => {
    console.log(`HTTP server listening on port ${options.httpPort}`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    tlsServer.close();
    httpServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    tlsServer.close();
    httpServer.close();
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs };

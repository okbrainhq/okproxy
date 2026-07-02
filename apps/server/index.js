#!/usr/bin/env node
// Server Entry Point - TLS + mTLS with multipath support

const { createTLSServer } = require('./lib/tls-server');
const { createHTTPServer } = require('./lib/http-router');
const { ConnectionPool } = require('./lib/connection-pool');
const { MultiClientManager } = require('./lib/multi-client-manager');

const DEFAULT_KEY = './.certs/server-key.pem';
const DEFAULT_CERT = './.certs/server-cert.pem';
const DEFAULT_CA = './.ca/ca-cert.pem';
const DEFAULT_CA_DIR = './.ca';

function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
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
    keepaliveTimeout: 25000,
    httpKeepAliveTimeout: 60 * 60 * 1000,
    httpHeadersTimeout: (60 * 60 * 1000) + 5000,
    certBoundDomains: false,
    issuedDomainIndex: './.ca/issued-domains.json',
    maxBodySize: undefined,
    httpHost: undefined
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
      case '--http-keepalive-timeout':
        options.httpKeepAliveTimeout = parseInt(args[++i], 10);
        break;
      case '--http-headers-timeout':
        options.httpHeadersTimeout = parseInt(args[++i], 10);
        break;
      case '--cert-bound-domains':
        options.certBoundDomains = true;
        break;
      case '--issued-domain-index':
        options.issuedDomainIndex = args[++i];
        break;
      case '--http-host':
        options.httpHost = args[++i];
        break;
      case '--max-body-size':
        const rawValue = args[++i];
        if (!/^[0-9]+$/.test(rawValue)) {
          console.error(`Error: Invalid max body size "${rawValue}". Must be a positive integer.`);
          process.exit(1);
        }
        const maxBodySize = Number(rawValue);
        if (!Number.isSafeInteger(maxBodySize) || maxBodySize < 1) {
          console.error(`Error: Invalid max body size. Must be a positive safe integer.`);
          process.exit(1);
        }
        options.maxBodySize = maxBodySize;
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
  --keepalive-timeout <ms>    PONG timeout (default: 25000)
  --http-keepalive-timeout <ms> HTTP keep-alive timeout for Caddy/browser side (default: 3600000)
  --http-headers-timeout <ms> HTTP headers timeout (default: 3605000)
  --cert-bound-domains        Enable certificate-bound Host routing
  --issued-domain-index <p>   Issued domain index (default: ./.ca/issued-domains.json)
  --http-host <host>          HTTP listen host (recommended: 127.0.0.1)
  --max-body-size <bytes>     Max HTTP request body size in bytes (default: 230686720, i.e. 220MB)
  --help                      Show this help
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

  const connectionPool = options.certBoundDomains
    ? new MultiClientManager(options)
    : new ConnectionPool();

  const tlsServer = createTLSServer(connectionPool, options);

  const httpServer = createHTTPServer(connectionPool, tlsServer, options);

  tlsServer.listen(options.tlsPort, () => {
    console.log(`TLS tunnel server listening on port ${options.tlsPort}`);
  });

  httpServer.listen(options.httpPort, options.httpHost, () => {
    const addr = options.httpHost ? `${options.httpHost}:${options.httpPort}` : `port ${options.httpPort}`;
    console.log(`HTTP server listening on ${addr}`);
  });

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

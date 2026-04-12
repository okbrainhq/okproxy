#!/usr/bin/env node
// Client Entry Point - TLS only

const { createProxy } = require('./lib/proxy');
const { createTLSConnection } = require('./lib/tls-connection');

const DEFAULT_KEY = './.certs/client-key.pem';
const DEFAULT_CERT = './.certs/client-cert.pem';
const DEFAULT_CA = './.ca/ca-cert.pem';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    serverHost: 'localhost',
    serverPort: 9443,
    targetHost: 'localhost',
    targetPort: 3000,
    clientKey: DEFAULT_KEY,
    clientCert: DEFAULT_CERT,
    caCert: DEFAULT_CA
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--server':
        const server = args[++i];
        const [host, port] = server.split(':');
        options.serverHost = host;
        options.serverPort = parseInt(port, 10) || 9443;
        break;
      case '--target':
        const target = args[++i];
        const [tHost, tPort] = target.split(':');
        options.targetHost = tHost;
        options.targetPort = parseInt(tPort, 10) || 3000;
        break;
      case '--key':
        options.clientKey = args[++i];
        break;
      case '--cert':
        options.clientCert = args[++i];
        break;
      case '--ca':
        options.caCert = args[++i];
        break;
      case '--help':
        console.log(`
Usage: node index.js [options]

Options:
  --server <host:port>    Tunnel server address (default: localhost:9443)
  --target <host:port>    Local target service (default: localhost:3000)
  --key <path>            Client private key (default: ${DEFAULT_KEY})
  --cert <path>           Client certificate (default: ${DEFAULT_CERT})
  --ca <path>             CA certificate to verify server (default: ${DEFAULT_CA})
  --help                  Show this help

Examples:
  # With default certificate paths
  node apps/client/index.js

  # With custom certificate paths
  node apps/client/index.js \\
    --key ./certs/client-key.pem \\
    --cert ./certs/client-cert.pem \\
    --ca ./.ca/ca-cert.pem
        `);
        process.exit(0);
    }
  }

  return options;
}

function main() {
  const config = parseArgs();

  console.log('Starting TLS tunnel client...');
  console.log(`Server: ${config.serverHost}:${config.serverPort}`);
  console.log(`Target: ${config.targetHost}:${config.targetPort}`);

  let proxy = null;

  // Create TLS connection
  const connection = createTLSConnection(
    config,
    (frame) => {
      if (proxy) {
        proxy.handleFrame(frame);
      }
    },
    () => {
      console.log('Connected to TLS tunnel server');
      proxy = createProxy(connection, config.targetPort, config.targetHost);
    },
    () => {
      console.log('Disconnected from TLS tunnel server');
      if (proxy) {
        proxy.destroy();
        proxy = null;
      }
    }
  );

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    connection.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    connection.destroy();
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs };

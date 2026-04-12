#!/usr/bin/env node
// CA CLI Tool - Certificate Authority management

const {
  initCA,
  issueClientCertificate,
  issueServerCertificate,
  revokeCertificate,
  listCertificates
} = require('../lib/ca');

const DEFAULT_CA_DIR = './.ca';
const DEFAULT_OUTPUT_DIR = './.certs';

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init': {
      const caDirIdx = args.indexOf('--ca-dir');
      const caDir = caDirIdx !== -1 ? args[caDirIdx + 1] : DEFAULT_CA_DIR;
      initCA(caDir);
      break;
    }

    case 'issue-client': {
      const outputIdx = args.indexOf('--output');
      const caDirIdx = args.indexOf('--ca-dir');

      const caDir = caDirIdx !== -1 ? args[caDirIdx + 1] : DEFAULT_CA_DIR;
      const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : DEFAULT_OUTPUT_DIR;

      issueClientCertificate(outputDir, caDir);
      break;
    }

    case 'issue-server': {
      const hostnameIdx = args.indexOf('--hostname');
      const outputIdx = args.indexOf('--output');
      const caDirIdx = args.indexOf('--ca-dir');

      if (hostnameIdx === -1) {
        console.error('Usage: tunnel-ca.js issue-server --hostname <name> [--output <dir>] [--ca-dir <dir>]');
        process.exit(1);
      }

      const caDir = caDirIdx !== -1 ? args[caDirIdx + 1] : DEFAULT_CA_DIR;
      const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : DEFAULT_OUTPUT_DIR;

      issueServerCertificate(args[hostnameIdx + 1], outputDir, caDir);
      break;
    }

    case 'revoke': {
      const serialIdx = args.indexOf('--serial');
      const caDirIdx = args.indexOf('--ca-dir');

      if (serialIdx === -1) {
        console.error('Usage: tunnel-ca.js revoke --serial <number> [--ca-dir <dir>]');
        process.exit(1);
      }

      const caDir = caDirIdx !== -1 ? args[caDirIdx + 1] : DEFAULT_CA_DIR;
      revokeCertificate(parseInt(args[serialIdx + 1], 10), caDir);
      break;
    }

    case 'list': {
      const caDirIdx = args.indexOf('--ca-dir');
      const caDir = caDirIdx !== -1 ? args[caDirIdx + 1] : DEFAULT_CA_DIR;
      const certs = listCertificates(caDir);
      if (certs.length === 0) {
        console.log('No certificates issued');
      } else {
        console.table(certs);
      }
      break;
    }

    default:
      console.log(`
Usage: tunnel-ca.js <command> [options]

Commands:
  init [--ca-dir <dir>]                     Initialize CA
  issue-client [--output <dir>]             Issue client certificate
          [--ca-dir <dir>]                   CA directory (default: ${DEFAULT_CA_DIR})
  issue-server --hostname <h>               Issue server certificate
          [--output <dir>]                   Output directory (default: ${DEFAULT_OUTPUT_DIR})
          [--ca-dir <dir>]                   CA directory (default: ${DEFAULT_CA_DIR})
  revoke --serial <number>                  Revoke certificate
          [--ca-dir <dir>]                   CA directory (default: ${DEFAULT_CA_DIR})
  list [--ca-dir <dir>]                     List all certificates

Examples:
  # Initialize CA
  node tunnel-ca.js init

  # Issue client certificate
  node tunnel-ca.js issue-client

  # Issue server certificate with SAN
  node tunnel-ca.js issue-server --hostname localhost

  # List all certificates
  node tunnel-ca.js list

  # Revoke certificate by serial number
  node tunnel-ca.js revoke --serial 42
      `);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

// Certificate Authority - Manages CA operations using OpenSSL CLI
// Note: openssl CLI is a runtime dependency for CA operations only

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync, copyFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const DEFAULT_CA_DIR = './.ca';

// In-memory cache for certificate revocation list (CRL)
// This avoids reading from disk on every TLS connection
const crlCache = new Map(); // caDir -> { revokedSerials: Set, lastModified: number }

/**
 * Initialize Certificate Authority
 * Creates CA key pair and self-signed certificate
 * @param {string} caDir - Directory to store CA files
 */
function initCA(caDir = DEFAULT_CA_DIR) {
  if (!existsSync(caDir)) {
    mkdirSync(caDir, { recursive: true });
  }

  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');

  // Generate CA private key (4096-bit for long-lived CA keys)
  execFileSync('openssl', ['genrsa', '-out', caKeyPath, '4096'], { stdio: 'pipe' });
  chmodSync(caKeyPath, 0o600);

  // Self-sign CA certificate (valid for 10 years)
  execFileSync(
    'openssl',
    ['req', '-x509', '-new', '-key', caKeyPath, '-out', caCertPath, '-days', '3650', '-subj', '/CN=Tunnel-CA'],
    { stdio: 'pipe' }
  );

  // Initialize tracking files with restricted permissions (0o600 - owner read/write only)
  const crlPath = join(caDir, 'crl.txt');
  const issuedPath = join(caDir, 'issued.txt');
  const serialPath = join(caDir, 'serial-counter.txt');

  writeFileSync(crlPath, '', { mode: 0o600 });
  writeFileSync(issuedPath, '', { mode: 0o600 });
  writeFileSync(serialPath, '1', { mode: 0o600 });

  console.log('CA initialized');
  console.log('CA Certificate:', caCertPath);
  console.log('CA Private Key:', caKeyPath);

  return {
    caCertPath,
    caKeyPath
  };
}

/**
 * Get next serial number and increment counter
 * @param {string} caDir - CA directory
 * @returns {number} Next serial number
 */
function getNextSerial(caDir = DEFAULT_CA_DIR) {
  const counterPath = join(caDir, 'serial-counter.txt');
  const counter = parseInt(readFileSync(counterPath, 'utf8'), 10);
  writeFileSync(counterPath, String(counter + 1));
  return counter;
}

/**
 * Issue a client certificate
 * @param {string} outputDir - Directory to output certificate files
 * @param {string} caDir - CA directory
 * @returns {Object} Certificate info { serial, certPath, keyPath, caPath }
 */
function issueClientCertificate(outputDir, caDir = DEFAULT_CA_DIR) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const serial = getNextSerial(caDir);

  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');

  const clientKeyPath = join(outputDir, 'client-key.pem');
  const clientCertPath = join(outputDir, 'client-cert.pem');
  const clientCsrPath = join(outputDir, 'client.csr');
  const caOutPath = join(outputDir, 'ca-cert.pem');

  // Generate client private key
  execFileSync('openssl', ['genrsa', '-out', clientKeyPath, '2048'], { stdio: 'pipe' });
  chmodSync(clientKeyPath, 0o600);

  // Create certificate signing request (generic CN, identity comes from serial)
  execFileSync(
    'openssl',
    ['req', '-new', '-key', clientKeyPath, '-out', clientCsrPath, '-subj', '/CN=tunnel-client'],
    { stdio: 'pipe' }
  );

  // Sign certificate with CA (valid for 90 days)
  execFileSync(
    'openssl',
    ['x509', '-req', '-in', clientCsrPath, '-CA', caCertPath, '-CAkey', caKeyPath, '-out', clientCertPath, '-days', '90', '-set_serial', String(serial)],
    { stdio: 'pipe' }
  );

  // Copy CA cert to output directory (using fs.copyFileSync instead of exec)
  const { copyFileSync } = require('node:fs');
  copyFileSync(caCertPath, caOutPath);

  // Clean up CSR
  try {
    const { unlinkSync } = require('node:fs');
    unlinkSync(clientCsrPath);
  } catch {
    // Ignore cleanup errors
  }

  // Track issued certificate (serial only, no client ID needed)
  appendFileSync(
    join(caDir, 'issued.txt'),
    `${serial}\t-\t${new Date().toISOString()}\n`
  );

  console.log(`Client certificate issued (serial: ${serial})`);
  console.log('  Key:', clientKeyPath);
  console.log('  Cert:', clientCertPath);
  console.log('  CA:', caOutPath);

  return {
    serial,
    certPath: clientCertPath,
    keyPath: clientKeyPath,
    caPath: caOutPath
  };
}

/**
 * Validate hostname format (prevents injection in certificate subjects)
 * @param {string} hostname - Hostname to validate
 * @returns {boolean} True if valid
 */
function isValidHostname(hostname) {
  // Allow: alphanumeric, dots, hyphens, and IPv4 addresses
  // Block: shell metacharacters, quotes, backticks, dollar signs, etc.
  const validPattern = /^[a-zA-Z0-9.-]+$/;
  if (!validPattern.test(hostname)) {
    return false;
  }
  // Additional check: no consecutive dots, no leading/trailing dots or hyphens
  if (hostname.startsWith('.') || hostname.startsWith('-') || 
      hostname.endsWith('.') || hostname.endsWith('-')) {
    return false;
  }
  if (hostname.includes('..')) {
    return false;
  }
  return true;
}

/**
 * Issue a server certificate
 * @param {string} hostname - Server hostname
 * @param {string} outputDir - Directory to output certificate files
 * @param {string} caDir - CA directory
 * @returns {Object} Certificate info
 */
function issueServerCertificate(hostname, outputDir, caDir = DEFAULT_CA_DIR) {
  // Validate hostname to prevent injection
  if (!isValidHostname(hostname)) {
    throw new Error(`Invalid hostname: ${hostname}. Hostname must contain only alphanumeric characters, dots, and hyphens.`);
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');

  const serverKeyPath = join(outputDir, 'server-key.pem');
  const serverCertPath = join(outputDir, 'server-cert.pem');
  const serverCsrPath = join(outputDir, 'server.csr');
  const tempConfig = join(outputDir, '.openssl.cnf');

  // Generate server private key
  execFileSync('openssl', ['genrsa', '-out', serverKeyPath, '2048'], { stdio: 'pipe' });
  chmodSync(serverKeyPath, 0o600);

  // Create temp config for SAN extension
  const sanExt = hostname.includes(':') || /^\d+$/.test(hostname.replace(/\./g, ''))
    ? `IP:${hostname}`
    : `DNS:${hostname}`;
  writeFileSync(tempConfig, `[req]\ndistinguished_name=dn\n[dn]\n[SAN]\nsubjectAltName=${sanExt}\n`);

  // Create CSR with SAN - using execFileSync to avoid shell injection
  execFileSync(
    'openssl',
    [
      'req', '-new',
      '-key', serverKeyPath,
      '-out', serverCsrPath,
      '-subj', `/CN=${hostname}`,
      '-config', tempConfig,
      '-reqexts', 'SAN'
    ],
    { stdio: 'pipe' }
  );

  // Sign certificate with CA (valid for 1 year)
  execFileSync(
    'openssl',
    ['x509', '-req', '-in', serverCsrPath, '-CA', caCertPath, '-CAkey', caKeyPath, '-out', serverCertPath, '-days', '365', '-extfile', tempConfig, '-extensions', 'SAN'],
    { stdio: 'pipe' }
  );

  // Clean up
  try {
    const { unlinkSync } = require('node:fs');
    unlinkSync(serverCsrPath);
    unlinkSync(tempConfig);
  } catch {
    // Ignore cleanup errors
  }

  console.log(`Server certificate issued for ${hostname}`);
  console.log('  Key:', serverKeyPath);
  console.log('  Cert:', serverCertPath);

  return {
    hostname,
    certPath: serverCertPath,
    keyPath: serverKeyPath
  };
}

/**
 * Load CRL from file into memory cache
 * @param {string} caDir - CA directory
 * @returns {Set<string>} Set of normalized revoked serials
 */
function loadCRLIntoCache(caDir) {
  try {
    const crlPath = join(caDir, 'crl.txt');
    const crl = readFileSync(crlPath, 'utf8');
    const revokedSerials = new Set(
      crl.split('\n')
        .filter(Boolean)
        .map(s => String(s).toLowerCase().replace(/^0+/, '') || '0')
    );
    crlCache.set(caDir, { revokedSerials });
    return revokedSerials;
  } catch {
    // If file doesn't exist, return empty set
    crlCache.set(caDir, { revokedSerials: new Set() });
    return new Set();
  }
}

/**
 * Revoke a certificate by serial number
 * @param {number} serial - Certificate serial number
 * @param {string} caDir - CA directory
 */
function revokeCertificate(serial, caDir = DEFAULT_CA_DIR) {
  appendFileSync(join(caDir, 'crl.txt'), `${serial}\n`);
  // Invalidate cache for this CA directory
  crlCache.delete(caDir);
  console.log(`Certificate revoked (serial: ${serial})`);
}

/**
 * Check if a certificate serial is revoked
 * Uses in-memory cache to avoid file I/O on every TLS connection
 * @param {number|string} serial - Certificate serial number (can be hex from OpenSSL or decimal)
 * @param {string} caDir - CA directory
 * @returns {boolean} True if revoked
 */
function isRevoked(serial, caDir = DEFAULT_CA_DIR) {
  // Get or load cached CRL
  let cached = crlCache.get(caDir);
  if (!cached) {
    cached = { revokedSerials: loadCRLIntoCache(caDir) };
  }

  // Normalize the input serial - it could be hex (from OpenSSL) or decimal
  const normalizedSerial = String(serial).toLowerCase().replace(/^0+/, '') || '0';

  // Check if serial is in the revoked set
  return cached.revokedSerials.has(normalizedSerial);
}

/**
 * List all issued certificates
 * @param {string} caDir - CA directory
 * @returns {Array<{serial: number, issuedAt: string, revoked: boolean}>}
 */
function listCertificates(caDir = DEFAULT_CA_DIR) {
  try {
    const issued = readFileSync(join(caDir, 'issued.txt'), 'utf8');
    const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
    const revokedSerials = new Set(crl.split('\n').filter(Boolean));

    return issued.split('\n').filter(Boolean).map(line => {
      const [serial, , issuedAt] = line.split('\t');
      return {
        serial: parseInt(serial, 10),
        issuedAt,
        revoked: revokedSerials.has(serial)
      };
    });
  } catch {
    return [];
  }
}

module.exports = {
  initCA,
  issueClientCertificate,
  issueServerCertificate,
  revokeCertificate,
  isRevoked,
  listCertificates,
  isValidHostname
};

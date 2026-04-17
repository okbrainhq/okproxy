// Certificate Authority - Manages CA operations using OpenSSL CLI
// Note: openssl CLI is a runtime dependency for CA operations only

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync, copyFileSync, unlinkSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');

const DEFAULT_CA_DIR = './.ca';

/**
 * Create a temporary combined CA file (cert + key) for signing operations.
 * When the CA cert and key are in the same file, openssl x509 -req
 * doesn't need -CAkey on the command line (avoiding exposure in /proc).
 * File is created in os.tmpdir() and cleaned up after use.
 * @param {string} caDir - CA directory
 * @returns {string} Path to temporary combined file
 */
function createTempCAFile(caDir) {
  const caKeyPath = join(caDir, 'ca-key.pem');
  const caCertPath = join(caDir, 'ca-cert.pem');
  // Use random filename in tmpdir to avoid collisions and ensure cleanup on crash
  const randomSuffix = randomBytes(8).toString('hex');
  const tempCAPath = join(tmpdir(), `.tunzero-ca-combined-${randomSuffix}.pem`);
  const combined = readFileSync(caCertPath, 'utf8') + readFileSync(caKeyPath, 'utf8');
  writeFileSync(tempCAPath, combined, { mode: 0o600 });
  return tempCAPath;
}

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
  writeFileSync(counterPath, String(counter + 1), { mode: 0o600 });
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
  // Use temp combined CA file to avoid CA key path in /proc/<pid>/cmdline
  const tempCAFile = createTempCAFile(caDir);
  try {
    execFileSync(
      'openssl',
      ['x509', '-req', '-in', clientCsrPath, '-CA', tempCAFile, '-out', clientCertPath, '-days', '90', '-set_serial', String(serial)],
      { stdio: 'pipe' }
    );
  } finally {
    try {
      unlinkSync(tempCAFile);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Copy CA cert to output directory
  copyFileSync(caCertPath, caOutPath);

  // Clean up CSR
  try {
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
 * @param {string} hostname - Hostname to validate (supports IPv4, IPv6, and hostnames)
 * @returns {boolean} True if valid
 */
function isValidHostname(hostname) {
  // IPv6 addresses: allow [addr] or [addr]:port format
  if (hostname.startsWith('[')) {
    // IPv6 literal with optional port: [2001:db8::1] or [2001:db8::1]:8080
    const ipv6Pattern = /^\[([a-fA-F0-9:]+)\](:\d+)?$/;
    if (!ipv6Pattern.test(hostname)) {
      return false;
    }
    // Validate the IPv6 part doesn't contain shell metacharacters
    const ipv6Part = hostname.match(/^\[([a-fA-F0-9:]+)\]/)[1];
    if (/[^a-fA-F0-9:]/.test(ipv6Part)) {
      return false;
    }
    return true;
  }

  // IPv4 addresses and hostnames: alphanumeric, dots, hyphens
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

  const caCertPath = join(caDir, 'ca-cert.pem');

  const serverKeyPath = join(outputDir, 'server-key.pem');
  const serverCertPath = join(outputDir, 'server-cert.pem');
  const serverCsrPath = join(outputDir, 'server.csr');
  const tempConfig = join(outputDir, '.openssl.cnf');

  // Generate server private key
  execFileSync('openssl', ['genrsa', '-out', serverKeyPath, '2048'], { stdio: 'pipe' });
  chmodSync(serverKeyPath, 0o600);

  // Create temp config for SAN extension
  let sanExt;
  if (hostname.startsWith('[')) {
    // IPv6 address: [addr] or [addr]:port - extract just the IP for SAN
    const ipv6Match = hostname.match(/^\[([a-fA-F0-9:]+)\]/);
    sanExt = ipv6Match ? `IP:${ipv6Match[1]}` : `DNS:${hostname}`;
  } else if (hostname.includes(':') || /^\d+$/.test(hostname.replace(/\./g, ''))) {
    sanExt = `IP:${hostname}`;
  } else {
    sanExt = `DNS:${hostname}`;
  }
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
  // Use temp combined CA file to avoid CA key path in /proc/<pid>/cmdline
  const tempCAFile = createTempCAFile(caDir);
  try {
    execFileSync(
      'openssl',
      ['x509', '-req', '-in', serverCsrPath, '-CA', tempCAFile, '-out', serverCertPath, '-days', '365', '-extfile', tempConfig, '-extensions', 'SAN'],
      { stdio: 'pipe' }
    );
  } finally {
    try {
      unlinkSync(tempCAFile);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Clean up
  try {
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
    const stats = statSync(crlPath);
    const crl = readFileSync(crlPath, 'utf8');
    const revokedSerials = new Set(
      crl.split('\n')
        .filter(Boolean)
        .map(s => String(s).toLowerCase().replace(/^0+/, '') || '0')
    );
    crlCache.set(caDir, { revokedSerials, lastModified: stats.mtimeMs });
    return revokedSerials;
  } catch {
    // If file doesn't exist, return empty set with timestamp 0
    crlCache.set(caDir, { revokedSerials: new Set(), lastModified: 0 });
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
 *
 * The CRL stores decimal serials (written by revokeCertificate/issueClientCertificate).
 * Node.js exposes cert.serialNumber as an uppercase hex string, so the input is
 * always parsed as hex and converted to decimal for lookup. Dual-format matching
 * was tried previously and caused false positives (e.g. revoking decimal 10 would
 * also flag a cert with decimal serial 16, whose hex form is "10").
 *
 * @param {number|string} serial - Certificate serial number as hex (from TLS socket)
 * @param {string} caDir - CA directory
 * @returns {boolean} True if revoked
 */
function isRevoked(serial, caDir = DEFAULT_CA_DIR) {
  let cached = crlCache.get(caDir);
  let needsReload = !cached;

  // Check if CRL file has been modified since last load
  if (!needsReload) {
    try {
      const crlPath = join(caDir, 'crl.txt');
      const stats = statSync(crlPath);
      needsReload = stats.mtimeMs > (cached.lastModified || 0);
    } catch {
      // File doesn't exist or can't be accessed, use cached if available
    }
  }

  if (needsReload) {
    loadCRLIntoCache(caDir);
    cached = crlCache.get(caDir);
  }

  const parsed = parseInt(String(serial), 16);
  if (!Number.isFinite(parsed)) return false;
  return cached.revokedSerials.has(String(parsed));
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

// Certificate Authority - Manages CA operations using OpenSSL CLI
// Note: openssl CLI is a runtime dependency for CA operations only

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync, copyFileSync, unlinkSync, statSync, renameSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { join } = require('node:path');
const { normalizeDomains } = require('./domain-utils');
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
  const tempCAPath = join(tmpdir(), `.okproxy-ca-combined-${randomSuffix}.pem`);
  const combined = readFileSync(caCertPath, 'utf8') + readFileSync(caKeyPath, 'utf8');
  writeFileSync(tempCAPath, combined, { mode: 0o600 });
  return tempCAPath;
}

// In-memory cache for certificate revocation list (CRL)
// This avoids reading from disk on every TLS connection
const crlCache = new Map(); // caDir -> { revokedSerials: Set, lastModified: number }

// In-process CA event bus. Revocation has to reach live session managers so
// already-authenticated tunnel sessions can be evicted immediately instead of
// only being rejected on the next TLS handshake.
//
// Note: the `ca` CLI (apps/server/bin/tunnel-ca.js) revokes in a separate
// process, so its revocations cannot be observed here. Servers must also poll
// the CRL (see MultiClientManager#evictRevokedSessions) — that hook is
// documented in docs/http-server-fixes.md and is intentionally not wired into
// tls-server.js from this change.
const caEvents = new EventEmitter();
caEvents.setMaxListeners(0);

/**
 * Subscribe to in-process certificate revocation events.
 * @param {(event: {serial: string, caDir: string, domains: string[]}) => void} listener
 * @returns {() => void} unsubscribe function
 */
function onCertificateRevoked(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  caEvents.on('certificate-revoked', listener);
  return () => caEvents.off('certificate-revoked', listener);
}

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
function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * Atomically write a JSON metadata file.
 *
 * CA metadata (certs.json / issued-domains.json) is read by the routing hot
 * path. A plain writeFileSync can leave a truncated file if the process dies
 * mid-write, which previously made every public request throw while parsing.
 * Write to a sibling temp file and rename() into place so readers only ever
 * observe a complete document.
 */
function writeJsonFile(path, value) {
  const payload = JSON.stringify(value, null, 2) + '\n';
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempPath, payload, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Validate parsed certificate metadata.
 * Returns a usable `{ version, certs }` shape even when the file is missing,
 * truncated, or hand-edited into an unexpected shape. Non-object entries are
 * dropped so callers cannot crash on `cert.status` / `cert.domains`.
 */
function normalizeCertMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, certs: [] };
  }
  const certs = Array.isArray(raw.certs)
    ? raw.certs.filter((cert) => cert && typeof cert === 'object' && !Array.isArray(cert))
    : [];
  return { version: Number.isFinite(raw.version) ? raw.version : 1, certs };
}

function loadCertMetadata(caDir = DEFAULT_CA_DIR) {
  return normalizeCertMetadata(readJsonFile(join(caDir, 'certs.json'), null));
}

function saveCertMetadata(caDir, metadata) {
  writeJsonFile(join(caDir, 'certs.json'), metadata);
}

function rebuildIssuedDomainIndex(caDir = DEFAULT_CA_DIR) {
  const metadata = loadCertMetadata(caDir);
  const domains = {};
  for (const cert of metadata.certs || []) {
    if (cert.status !== 'valid') continue;
    const certDomains = Array.isArray(cert.domains) ? cert.domains : [];
    for (const domainValue of certDomains) {
      if (typeof domainValue !== 'string') continue;
      const domain = domainValue.trim().toLowerCase();
      if (!domain) continue;
      if (!domains[domain]) domains[domain] = { serials: [], status: 'valid' };
      domains[domain].serials.push(String(cert.serial));
    }
  }
  writeJsonFile(join(caDir, 'issued-domains.json'), { version: 1, domains });
  return { version: 1, domains };
}

/**
 * Issue a client certificate
 * @param {string} outputDir - Directory to output certificate files
 * @param {string} caDir - CA directory
 * @param {Object} options - { domains, name, allowDomainOverlap }
 * @returns {Object} Certificate info { serial, certPath, keyPath, caPath, domains }
 */
function issueClientCertificate(outputDir, caDir = DEFAULT_CA_DIR, options = {}) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const domains = normalizeDomains(options.domains || []);
  const metadata = loadCertMetadata(caDir);

  if (!options.allowDomainOverlap && domains.length > 0) {
    const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
    const revokedSerials = new Set(crl.split('\n').filter(Boolean));
    for (const cert of metadata.certs || []) {
      if (cert.status !== 'valid' || revokedSerials.has(String(cert.serial))) continue;
      const certDomains = Array.isArray(cert.domains) ? cert.domains : [];
      for (const domain of domains) {
        if (certDomains.includes(domain)) {
          throw new Error(`Domain already issued to valid certificate ${cert.serial}: ${domain}`);
        }
      }
    }
  }

  const serial = getNextSerial(caDir);
  const caCertPath = join(caDir, 'ca-cert.pem');

  const clientKeyPath = join(outputDir, 'client-key.pem');
  const clientCertPath = join(outputDir, 'client-cert.pem');
  const clientCsrPath = join(outputDir, 'client.csr');
  const caOutPath = join(outputDir, 'ca-cert.pem');
  const tempConfig = join(outputDir, '.client-openssl.cnf');

  // Generate client private key
  execFileSync('openssl', ['genrsa', '-out', clientKeyPath, '2048'], { stdio: 'pipe' });
  chmodSync(clientKeyPath, 0o600);

  const reqConfig = [
    '[req]',
    'distinguished_name=dn',
    '[dn]',
    '[client_ext]',
    'extendedKeyUsage=clientAuth'
  ];
  if (domains.length > 0) {
    reqConfig.push(`subjectAltName=${domains.map(d => `DNS:${d}`).join(',')}`);
  }
  writeFileSync(tempConfig, reqConfig.join('\n') + '\n', { mode: 0o600 });

  // Create certificate signing request (generic CN, identity comes from serial)
  execFileSync(
    'openssl',
    ['req', '-new', '-key', clientKeyPath, '-out', clientCsrPath, '-subj', `/CN=${options.name || 'tunnel-client'}`],
    { stdio: 'pipe' }
  );

  // Sign certificate with CA (valid for 365 days / 1 year), adding clientAuth and optional SAN domains.
  const tempCAFile = createTempCAFile(caDir);
  try {
    execFileSync(
      'openssl',
      ['x509', '-req', '-in', clientCsrPath, '-CA', tempCAFile, '-out', clientCertPath, '-days', '365', '-set_serial', String(serial), '-extfile', tempConfig, '-extensions', 'client_ext'],
      { stdio: 'pipe' }
    );
  } finally {
    try { unlinkSync(tempCAFile); } catch {}
  }

  copyFileSync(caCertPath, caOutPath);

  try {
    unlinkSync(clientCsrPath);
    unlinkSync(tempConfig);
  } catch {}

  const issuedAt = new Date().toISOString();
  appendFileSync(join(caDir, 'issued.txt'), `${serial}\t-\t${issuedAt}\n`);

  metadata.certs = metadata.certs || [];
  metadata.certs.push({
    serial: String(serial),
    name: options.name || '-',
    status: 'valid',
    issuedAt,
    domains
  });
  saveCertMetadata(caDir, metadata);
  rebuildIssuedDomainIndex(caDir);

  console.log(`Client certificate issued (serial: ${serial})`);
  if (domains.length > 0) console.log('  Domains:', domains.join(', '));
  console.log('  Key:', clientKeyPath);
  console.log('  Cert:', clientCertPath);
  console.log('  CA:', caOutPath);

  return {
    serial,
    certPath: clientCertPath,
    keyPath: clientKeyPath,
    caPath: caOutPath,
    domains
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
      ['x509', '-req', '-in', serverCsrPath, '-CA', tempCAFile, '-out', serverCertPath, '-days', '365', '-set_serial', String(getNextSerial(caDir)), '-extfile', tempConfig, '-extensions', 'SAN'],
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
  const serialString = String(serial === undefined || serial === null ? '' : serial).trim();
  if (!serialString) throw new Error('Serial is required to revoke a certificate');

  // The CRL is the security-critical record: write it first so revocation
  // takes effect even if metadata maintenance below fails.
  appendFileSync(join(caDir, 'crl.txt'), `${serialString}\n`);

  let domains = [];
  try {
    const metadata = loadCertMetadata(caDir);
    for (const cert of metadata.certs || []) {
      if (String(cert.serial) === serialString) {
        cert.status = 'revoked';
        domains = Array.isArray(cert.domains) ? cert.domains.slice() : [];
      }
    }
    saveCertMetadata(caDir, metadata);
    rebuildIssuedDomainIndex(caDir);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to update certificate metadata for revoked serial ${serialString}:`, err.message);
  }

  // Invalidate cache for this CA directory
  crlCache.delete(caDir);
  console.log(`Certificate revoked (serial: ${serialString})`);

  // Notify in-process listeners so live tunnel sessions can be evicted.
  caEvents.emit('certificate-revoked', { serial: serialString, caDir, domains });
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
    const metadata = loadCertMetadata(caDir);
    if (metadata.certs && metadata.certs.length > 0) {
      const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
      const revokedSerials = new Set(crl.split('\n').filter(Boolean));
      return metadata.certs.map(cert => ({
        serial: parseInt(cert.serial, 10),
        name: cert.name || '-',
        issuedAt: cert.issuedAt,
        revoked: cert.status === 'revoked' || revokedSerials.has(String(cert.serial)),
        domains: Array.isArray(cert.domains) ? cert.domains.join(',') : ''
      }));
    }
    const issued = readFileSync(join(caDir, 'issued.txt'), 'utf8');
    const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
    const revokedSerials = new Set(crl.split('\n').filter(Boolean));

    return issued.split('\n').filter(Boolean).map(line => {
      const [serial, , issuedAt] = line.split('\t');
      return { serial: parseInt(serial, 10), issuedAt, revoked: revokedSerials.has(serial), domains: '' };
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
  isValidHostname,
  rebuildIssuedDomainIndex,
  loadCertMetadata,
  onCertificateRevoked
};

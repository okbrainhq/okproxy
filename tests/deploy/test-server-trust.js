// Server trust-material regression tests (mocked/disposable).
//
// Covers:
//  - legacy migration precedence (.certs must NOT win over the historically
//    active certs layout) and coherent-set selection (pair + sibling CA)
//  - failure on partial/incoherent legacy material
//  - ensure_server_trust_set never regenerates an existing CA when the server
//    pair is missing/incomplete, and fails closed on mismatch/partial state

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  createTrustLayout,
  generateCa,
  issueServerCert,
  sourceScript
} = require('./helpers');

const SERVER_SCRIPT = 'scripts/deploy/setup-server-remote.sh';

function migrateLayout(sandbox, { appDir, certDir, caDir }) {
  return sourceScript(SERVER_SCRIPT, [], `
APP_DIR="$TEST_APP_DIR"
CERT_DIR="$TEST_CERT_DIR"
CA_DIR="$TEST_CA_DIR"
AS_ROOT=""
migrate_legacy_trust_material
echo "MIGRATION_DONE"
`, {
    OKPROXY_AS_ROOT: '',
    TEST_APP_DIR: appDir,
    TEST_CERT_DIR: certDir,
    TEST_CA_DIR: caDir
  });
}

function ensureTrustSet(certDir, caDir, hostname = 'server.example.test') {
  return sourceScript(SERVER_SCRIPT, [], `
APP_DIR="$TEST_REPO"
NODE_PATH="$TEST_NODE"
HOSTNAME="$TEST_HOSTNAME"
CERT_DIR="$TEST_CERT_DIR"
CA_DIR="$TEST_CA_DIR"
AS_ROOT=""
ensure_server_trust_set
echo "TRUST_SET_DONE"
`, {
    OKPROXY_AS_ROOT: '',
    TEST_REPO: REPO_ROOT,
    TEST_NODE: process.execPath,
    TEST_HOSTNAME: hostname,
    TEST_CERT_DIR: certDir,
    TEST_CA_DIR: caDir
  });
}

function openssl(args) {
  return spawnSync('openssl', args, { encoding: 'utf8' });
}

function pubKeyHash(file, kind) {
  const args = kind === 'key'
    ? ['pkey', '-pubout', '-in', file]
    : ['x509', '-noout', '-pubkey', '-in', file];
  const res = openssl(args);
  assert.strictEqual(res.status, 0, `openssl ${args.join(' ')}: ${res.stderr}`);
  const hash = spawnSync('openssl', ['sha256'], { input: res.stdout, encoding: 'utf8' });
  return hash.stdout.trim();
}

function chainsTo(certFile, caFile) {
  return openssl(['verify', '-CAfile', caFile, certFile]).status === 0;
}

describe('legacy trust material migration', () => {
  it('keeps the historically active uploaded layout (certs+ca) over .certs+.ca', () => {
    const sandbox = createSandbox('okproxy-migrate-');
    try {
      const appDir = join(sandbox.root, 'app');
      const uploaded = createTrustLayout(appDir, {
        certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true, hostname: 'uploaded.example.test'
      });
      const generated = createTrustLayout(appDir, {
        certDirName: '.certs', caDirName: '.ca', hostname: 'generated.example.test'
      });
      const certDir = join(sandbox.root, 'data', 'certs');
      const caDir = join(sandbox.root, 'data', 'ca');

      const res = migrateLayout(sandbox, { appDir, certDir, caDir });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      assert.strictEqual(
        readFileSync(join(certDir, 'server-cert.pem'), 'utf8'),
        readFileSync(join(uploaded.certDir, 'server-cert.pem'), 'utf8'),
        'certs/ (historically active) must win over .certs/'
      );
      assert.strictEqual(
        readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'),
        readFileSync(join(uploaded.caDir, 'ca-cert.pem'), 'utf8'),
        'the CA must come from the same set as the certificate'
      );
      assert.notStrictEqual(
        readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'),
        readFileSync(join(generated.caDir, 'ca-cert.pem'), 'utf8')
      );
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('migrates the generated layout when no uploaded layout exists', () => {
    const sandbox = createSandbox('okproxy-migrate-gen-');
    try {
      const appDir = join(sandbox.root, 'app');
      const generated = createTrustLayout(appDir, {
        certDirName: '.certs', caDirName: '.ca', hostname: 'generated.example.test'
      });
      const certDir = join(sandbox.root, 'data', 'certs');
      const caDir = join(sandbox.root, 'data', 'ca');

      const res = migrateLayout(sandbox, { appDir, certDir, caDir });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.strictEqual(
        readFileSync(join(certDir, 'server-cert.pem'), 'utf8'),
        readFileSync(join(generated.certDir, 'server-cert.pem'), 'utf8')
      );
      assert.strictEqual(
        readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'),
        readFileSync(join(generated.caDir, 'ca-cert.pem'), 'utf8')
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed on partial legacy material (pair without its CA)', () => {
    const sandbox = createSandbox('okproxy-migrate-partial-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: '.certs', caDirName: '.ca' });
      rmSync(join(appDir, '.ca'), { recursive: true, force: true });

      const res = migrateLayout(sandbox, {
        appDir,
        certDir: join(sandbox.root, 'data', 'certs'),
        caDir: join(sandbox.root, 'data', 'ca')
      });
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /incomplete or incoherent/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed when the legacy cert does not chain to its sibling CA', () => {
    const sandbox = createSandbox('okproxy-migrate-mismatch-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true });
      // Replace the server cert with one issued by an unrelated CA.
      const otherCa = join(sandbox.root, 'other-ca');
      generateCa(otherCa);
      const otherCertDir = join(sandbox.root, 'other-certs');
      issueServerCert(otherCa, otherCertDir, 'other.example.test');
      writeFileSync(
        join(appDir, 'certs', 'server-cert.pem'),
        readFileSync(join(otherCertDir, 'server-cert.pem'))
      );

      const res = migrateLayout(sandbox, {
        appDir,
        certDir: join(sandbox.root, 'data', 'certs'),
        caDir: join(sandbox.root, 'data', 'ca')
      });
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /incomplete or incoherent/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed when the persistent CA differs from the legacy CA', () => {
    const sandbox = createSandbox('okproxy-migrate-two-cas-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true });
      const caDir = join(sandbox.root, 'data', 'ca');
      generateCa(caDir); // unrelated CA already in DATA_DIR

      const res = migrateLayout(sandbox, { appDir, certDir: join(sandbox.root, 'data', 'certs'), caDir });
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /two different CAs/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('leaves a complete coherent persistent set untouched', () => {
    const sandbox = createSandbox('okproxy-migrate-noop-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true });
      const certDir = join(sandbox.root, 'data', 'certs');
      const caDir = join(sandbox.root, 'data', 'ca');
      generateCa(caDir);
      issueServerCert(caDir, certDir, 'live.example.test');
      const beforeCert = readFileSync(join(certDir, 'server-cert.pem'), 'utf8');
      const beforeCa = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      const res = migrateLayout(sandbox, { appDir, certDir, caDir });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.strictEqual(readFileSync(join(certDir, 'server-cert.pem'), 'utf8'), beforeCert);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), beforeCa);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('carries over a legacy CA when no server pair exists', () => {
    const sandbox = createSandbox('okproxy-migrate-ca-only-');
    try {
      const appDir = join(sandbox.root, 'app');
      const legacyCa = join(appDir, 'ca');
      generateCa(legacyCa);
      const caDir = join(sandbox.root, 'data', 'ca');

      const res = migrateLayout(sandbox, { appDir, certDir: join(sandbox.root, 'data', 'certs'), caDir });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.strictEqual(
        readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'),
        readFileSync(join(legacyCa, 'ca-cert.pem'), 'utf8')
      );
      assert.ok(existsSync(join(caDir, 'ca-key.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('refuses to overwrite a partial CA directory (CA key only) and preserves it', () => {
    const sandbox = createSandbox('okproxy-migrate-partial-ca-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true });
      const caDir = join(sandbox.root, 'data', 'ca');
      mkdirSync(caDir, { recursive: true });
      const orphanKey = join(caDir, 'ca-key.pem');
      writeFileSync(orphanKey, 'ORPHAN-CA-KEY');
      const before = readFileSync(orphanKey, 'utf8');

      const res = migrateLayout(sandbox, { appDir, certDir: join(sandbox.root, 'data', 'certs'), caDir });
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /already contains files but no CA certificate/);
      assert.strictEqual(readFileSync(orphanKey, 'utf8'), before, 'recoverable CA key must not be overwritten');
      assert.ok(!existsSync(join(caDir, 'ca-cert.pem')), 'legacy CA must not be copied over partial state');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('refuses to overwrite a partial cert directory (orphan leaf key) and preserves it', () => {
    const sandbox = createSandbox('okproxy-migrate-partial-leaf-');
    try {
      const appDir = join(sandbox.root, 'app');
      createTrustLayout(appDir, { certDirName: 'certs', caDirName: 'ca', copyCaIntoCertDir: true });
      const certDir = join(sandbox.root, 'data', 'certs');
      mkdirSync(certDir, { recursive: true });
      const orphanKey = join(certDir, 'server-key.pem');
      writeFileSync(orphanKey, 'ORPHAN-LEAF-KEY');
      const before = readFileSync(orphanKey, 'utf8');

      const res = migrateLayout(sandbox, { appDir, certDir, caDir: join(sandbox.root, 'data', 'ca') });
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /already contains files but no complete server key pair/);
      assert.strictEqual(readFileSync(orphanKey, 'utf8'), before);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('ensure_server_trust_set', () => {
  it('issues a server pair from an existing CA without regenerating it', () => {
    const sandbox = createSandbox('okproxy-trust-issue-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      const beforeCa = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      const res = ensureTrustSet(certDir, caDir);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /issuing a server certificate from it/);

      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), beforeCa,
        'the CA certificate must not be regenerated');
      assert.ok(existsSync(join(caDir, 'ca-key.pem')), 'the CA key must be preserved');
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
      assert.strictEqual(
        pubKeyHash(join(certDir, 'server-key.pem'), 'key'),
        pubKeyHash(join(certDir, 'server-cert.pem'), 'cert')
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('re-issues only the pair when the existing pair is incomplete', () => {
    const sandbox = createSandbox('okproxy-trust-partial-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      mkdirSync(certDir, { recursive: true });
      // A cert without its key (half-copied deployment).
      issueServerCert(caDir, join(sandbox.root, 'tmp'), 'old.example.test');
      writeFileSync(
        join(certDir, 'server-cert.pem'),
        readFileSync(join(sandbox.root, 'tmp', 'server-cert.pem'))
      );
      const beforeCa = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      const res = ensureTrustSet(certDir, caDir);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /incomplete server key pair/);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), beforeCa);
      assert.ok(existsSync(join(certDir, 'server-key.pem')));
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed when the CA private key is missing (no CA regeneration)', () => {
    const sandbox = createSandbox('okproxy-trust-nokey-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      rmSync(join(caDir, 'ca-key.pem'), { force: true });
      const beforeCa = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /private key .*is missing|Refusing to regenerate the CA/);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), beforeCa);
      assert.ok(!existsSync(join(certDir, 'server-cert.pem')), 'must not fabricate a new server cert');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed when the existing pair does not match the existing CA', () => {
    const sandbox = createSandbox('okproxy-trust-mismatch-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      issueServerCert(caDir, certDir, 'foreign.example.test');
      const beforeCert = readFileSync(join(certDir, 'server-cert.pem'), 'utf8');
      const beforeCa = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      // Corrupt the CA cert copy pairing: sign the pair with a different CA.
      const otherCa = join(sandbox.root, 'other-ca');
      generateCa(otherCa);
      const otherPair = join(sandbox.root, 'other-pair');
      issueServerCert(otherCa, otherPair, 'foreign.example.test');
      writeFileSync(join(certDir, 'server-cert.pem'), readFileSync(join(otherPair, 'server-cert.pem')));

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /not a matching set/);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), beforeCa);
      assert.notStrictEqual(readFileSync(join(certDir, 'server-cert.pem'), 'utf8'), beforeCert);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('generates a fresh CA + pair only when nothing exists, then is idempotent', () => {
    const sandbox = createSandbox('okproxy-trust-fresh-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');

      const first = ensureTrustSet(certDir, caDir, 'fresh.example.test');
      assert.strictEqual(first.status, 0, first.stderr || first.stdout);
      assert.ok(existsSync(join(caDir, 'ca-cert.pem')));
      assert.ok(existsSync(join(caDir, 'ca-key.pem')));
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
      const caAfterFirst = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');

      const second = ensureTrustSet(certDir, caDir, 'fresh.example.test');
      assert.strictEqual(second.status, 0, second.stderr || second.stdout);
      assert.match(second.stdout, /validated against/);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), caAfterFirst);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
  it('aborts on a CA key-only state, preserving the key (no init)', () => {
    const sandbox = createSandbox('okproxy-trust-keyonly-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      mkdirSync(caDir, { recursive: true });
      const key = join(caDir, 'ca-key.pem');
      writeFileSync(key, 'RECOVERABLE-CA-KEY');
      const before = readFileSync(key, 'utf8');

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /partial or unrecognised trust material|Refusing to initialise/);
      assert.strictEqual(readFileSync(key, 'utf8'), before, 'CA key must be preserved');
      assert.ok(!existsSync(join(caDir, 'ca-cert.pem')), 'init must not run');
      assert.ok(!existsSync(join(certDir, 'server-cert.pem')), 'no leaf may be fabricated');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('aborts on a CA records-only state, preserving index/revocation files (no init)', () => {
    const sandbox = createSandbox('okproxy-trust-recordsonly-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      mkdirSync(caDir, { recursive: true });
      const records = {
        'issued.txt': 'client-1\nclient-2\n',
        'crl.txt': 'revoked-1\n',
        'serial-counter.txt': '42\n',
        'issued-domains.json': '{"domains":["a.example.test"]}\n'
      };
      for (const [name, body] of Object.entries(records)) {
        writeFileSync(join(caDir, name), body);
      }

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /Refusing to initialise a new CA/);
      for (const [name, body] of Object.entries(records)) {
        assert.strictEqual(readFileSync(join(caDir, name), 'utf8'), body, `${name} must be preserved`);
      }
      assert.ok(!existsSync(join(caDir, 'ca-cert.pem')), 'init must not run');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('counts hidden files as trust material (no init on a hidden-only state)', () => {
    const sandbox = createSandbox('okproxy-trust-hidden-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      mkdirSync(caDir, { recursive: true });
      writeFileSync(join(caDir, '.keep'), 'do-not-destroy');

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /Refusing to initialise a new CA/);
      assert.strictEqual(readFileSync(join(caDir, '.keep'), 'utf8'), 'do-not-destroy');
      assert.ok(!existsSync(join(caDir, 'ca-cert.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('aborts when only a leaf key exists and no CA is present (preserved)', () => {
    const sandbox = createSandbox('okproxy-trust-orphan-leaf-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      mkdirSync(certDir, { recursive: true });
      const leafKey = join(certDir, 'server-key.pem');
      writeFileSync(leafKey, 'ORPHAN-LEAF-KEY');

      const res = ensureTrustSet(certDir, caDir);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /Refusing to initialise a new CA/);
      assert.strictEqual(readFileSync(leafKey, 'utf8'), 'ORPHAN-LEAF-KEY');
      assert.ok(!existsSync(join(caDir, 'ca-cert.pem')), 'init must not run');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('initialises when the trust directories exist but are genuinely empty', () => {
    const sandbox = createSandbox('okproxy-trust-emptydirs-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      mkdirSync(certDir, { recursive: true });
      mkdirSync(caDir, { recursive: true });

      const res = ensureTrustSet(certDir, caDir, 'empty.example.test');
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.ok(existsSync(join(caDir, 'ca-cert.pem')));
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('preserves CA key and records while re-issuing an incomplete server pair', () => {
    const sandbox = createSandbox('okproxy-trust-preserve-ca-');
    try {
      const certDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      writeFileSync(join(caDir, 'crl.txt'), 'revoked-1\n');
      const caKeyBefore = readFileSync(join(caDir, 'ca-key.pem'), 'utf8');
      const caCertBefore = readFileSync(join(caDir, 'ca-cert.pem'), 'utf8');
      const crlBefore = readFileSync(join(caDir, 'crl.txt'), 'utf8');
      issueServerCert(caDir, join(sandbox.root, 'tmp'), 'old.example.test');
      mkdirSync(certDir, { recursive: true });
      writeFileSync(
        join(certDir, 'server-cert.pem'),
        readFileSync(join(sandbox.root, 'tmp', 'server-cert.pem'))
      );

      const res = ensureTrustSet(certDir, caDir);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.strictEqual(readFileSync(join(caDir, 'ca-key.pem'), 'utf8'), caKeyBefore);
      assert.strictEqual(readFileSync(join(caDir, 'ca-cert.pem'), 'utf8'), caCertBefore);
      assert.strictEqual(readFileSync(join(caDir, 'crl.txt'), 'utf8'), crlBefore);
      assert.ok(chainsTo(join(certDir, 'server-cert.pem'), join(caDir, 'ca-cert.pem')));
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

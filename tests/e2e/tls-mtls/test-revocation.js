// Certificate revocation tests.
//
// The CRL stores decimal serials (written by revokeCertificate and the issuer).
// Node's socket.getPeerCertificate().serialNumber is always an uppercase hex
// string, so isRevoked() treats its input as hex and converts to decimal for
// lookup.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isRevoked, revokeCertificate, initCA } = require('../../../apps/server/lib/ca');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function createTestCA() {
  const caDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
  initCA(caDir);
  return {
    caDir,
    cleanup() {
      rmSync(caDir, { recursive: true, force: true });
    }
  };
}

describe('CA: Certificate Revocation', () => {
  it('should detect revoked certificate by hex serial (uppercase)', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      // TLS returns hex strings like "2A" for serial 42
      assert.strictEqual(isRevoked('2A', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should detect revoked certificate by hex serial (lowercase)', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      assert.strictEqual(isRevoked('2a', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should detect revoked certificate by hex serial with leading zeros', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      assert.strictEqual(isRevoked('02a', caDir), true);
      assert.strictEqual(isRevoked('002A', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should detect revoked certificate for large serials (hex without a-f)', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(256, caDir);
      assert.strictEqual(isRevoked('100', caDir), true); // hex for 256
    } finally {
      cleanup();
    }
  });

  it('should detect multiple revoked serials', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      revokeCertificate(255, caDir); // hex "FF"
      revokeCertificate(256, caDir); // hex "100"

      assert.strictEqual(isRevoked('2A', caDir), true);
      assert.strictEqual(isRevoked('FF', caDir), true);
      assert.strictEqual(isRevoked('ff', caDir), true);
      assert.strictEqual(isRevoked('100', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should return false for non-revoked certificates', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      assert.strictEqual(isRevoked('2B', caDir), false);     // hex for 43
      assert.strictEqual(isRevoked('ABC123', caDir), false); // random hex
    } finally {
      cleanup();
    }
  });

  it('should not false-positive on hex/decimal collision', () => {
    // Regression: a previous fix also checked the input as-is against the CRL,
    // which caused "revoked decimal 10" to incorrectly match a cert with
    // decimal serial 16 (whose hex form is "10"). Lock that behavior down.
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(10, caDir);
      // Cert with decimal serial 16 — Node would report serialNumber "10"
      assert.strictEqual(isRevoked('10', caDir), false);
      // And the actually-revoked cert (decimal 10, hex "A") still matches
      assert.strictEqual(isRevoked('A', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should not false-positive for 20 vs 32 (hex "20")', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(20, caDir);
      // Cert with decimal serial 32 — hex "20"
      assert.strictEqual(isRevoked('20', caDir), false);
      // Revoked cert (decimal 20, hex "14") still matches
      assert.strictEqual(isRevoked('14', caDir), true);
    } finally {
      cleanup();
    }
  });

  it('should return false for invalid serial input', () => {
    const { caDir, cleanup } = createTestCA();
    try {
      revokeCertificate(42, caDir);
      assert.strictEqual(isRevoked('', caDir), false);
      assert.strictEqual(isRevoked('zzz', caDir), false);
    } finally {
      cleanup();
    }
  });
});

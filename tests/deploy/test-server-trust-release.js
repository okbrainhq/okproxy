// Behavioural tests for the server-side trust *release* layout.
//
// Regression: setup-server.sh used to overwrite the active
// /var/lib/okproxy/certs directory file by file, so an interrupted upload could
// leave a NEW certificate next to the OLD key.
//
// The active trust set is now one release directory referenced through a single
// symlink (/var/lib/okproxy/current). Uploads are staged outside the active
// directories, validated (key matches cert, cert chains to the CA) and promoted
// to a persistent release; activation is one atomic rename. Everything here runs
// the real script against throwaway sandbox directories with `AS_ROOT=""` — no
// host path, service or firewall is touched.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, readdirSync
} = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  generateCa,
  issueServerCert,
  opensslRun,
  sourceScript
} = require('./helpers');

const SERVER_SCRIPT = join(REPO_ROOT, 'scripts', 'deploy', 'setup-server-remote.sh');
const SERVER_SCRIPT_REL = 'scripts/deploy/setup-server-remote.sh';

function runCli(dataDir, args, env = {}) {
  return spawnSync('bash', [SERVER_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OKPROXY_DATA_DIR: dataDir, OKPROXY_AS_ROOT: '', ...env }
  });
}

function runSourced(dataDir, body, env = {}) {
  return sourceScript(SERVER_SCRIPT_REL, [], body, {
    OKPROXY_DATA_DIR: dataDir,
    OKPROXY_AS_ROOT: '',
    ...env
  });
}

function validate(dataDir, id) {
  return runCli(dataDir, [`--trust-release-validate=${id}`]);
}

function activate(dataDir, id, extra = []) {
  return runCli(dataDir, [`--trust-release-activate=${id}`, ...extra]);
}

function output(res) {
  return `${res.stdout || ''}${res.stderr || ''}`;
}

function sha(file) {
  return readFileSync(file, 'utf8');
}

function activeLink(dataDir) {
  const link = join(dataDir, 'current');
  if (!existsSync(link) && !isLink(link)) return null;
  return spawnSync('readlink', [link], { encoding: 'utf8' }).stdout.trim();
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function chains(cert, ca) {
  return opensslRun(['verify', '-CAfile', ca, cert]).length > 0;
}

/**
 * Build a complete staged release: certs/{server-cert,server-key}.pem and
 * ca/ca-cert.pem (+ metadata). `caDir` lets a test stage a certificate that was
 * issued by a different CA than the one it ships with.
 */
function buildStagedRelease(dataDir, id, options = {}) {
  const { caDir = null, foreignCaDir = null, corruptKey = false, omitKey = false, omitCa = false } = options;
  const staging = join(dataDir, 'staging', id);
  const certDir = join(staging, 'certs');
  const caTarget = join(staging, 'ca');
  mkdirSync(certDir, { recursive: true });
  mkdirSync(caTarget, { recursive: true });

  if (!caDir) {
    generateCa(caTarget);
  } else {
    writeFileSync(join(caTarget, 'ca-cert.pem'), readFileSync(join(caDir, 'ca-cert.pem')));
  }
  issueServerCert(caDir || caTarget, certDir, `${id}.example.test`);
  writeFileSync(join(certDir, 'ca-cert.pem'), readFileSync(join(caTarget, 'ca-cert.pem')));
  if (foreignCaDir) {
    // Certificate issued by one CA, shipped with a different CA: incoherent.
    writeFileSync(join(caTarget, 'ca-cert.pem'), readFileSync(join(foreignCaDir, 'ca-cert.pem')));
    writeFileSync(join(certDir, 'ca-cert.pem'), readFileSync(join(foreignCaDir, 'ca-cert.pem')));
  }
  if (corruptKey) {
    // A key that does not belong to the staged certificate.
    opensslRun(['genrsa', '-out', join(certDir, 'server-key.pem'), '2048']);
  }
  if (omitKey) {
    rmSync(join(certDir, 'server-key.pem'), { force: true });
  }
  if (omitCa) {
    rmSync(join(caTarget, 'ca-cert.pem'), { force: true });
  }
  writeFileSync(join(caTarget, 'issued-domains.json'), `{"domains":["${id}.example.test"]}\n`);
  writeFileSync(join(caTarget, 'crl.txt'), '');
  return staging;
}

function releaseDir(dataDir, id) {
  return join(dataDir, 'releases', id);
}

describe('trust release layout: staging, validation, atomic activation', () => {
  it('validates a staged release, promotes it, and only then activates it', () => {
    const sandbox = createSandbox('okproxy-release-');
    try {
      buildStagedRelease(sandbox.root, 'rel1');

      // Nothing active yet: validation alone must not touch the active layout.
      const validated = validate(sandbox.root, 'rel1');
      assert.strictEqual(validated.status, 0, output(validated));
      assert.match(validated.stdout, /staged and validated/);
      assert.strictEqual(activeLink(sandbox.root), null, 'validation must not activate anything');
      assert.ok(existsSync(join(releaseDir(sandbox.root, 'rel1'), 'READY')), 'READY marker must exist');
      assert.ok(!existsSync(join(sandbox.root, 'staging', 'rel1')), 'staging must be promoted');

      const activated = activate(sandbox.root, 'rel1');
      assert.strictEqual(activated.status, 0, output(activated));
      assert.match(activated.stdout, /Activated trust release rel1/);
      assert.ok(isLink(join(sandbox.root, 'current')), 'the active pointer must be a symlink');
      assert.strictEqual(activeLink(sandbox.root), 'releases/rel1');

      // The active material is exactly the validated release.
      assert.strictEqual(
        readFileSync(join(sandbox.root, 'current', 'certs', 'server-cert.pem'), 'utf8'),
        readFileSync(join(releaseDir(sandbox.root, 'rel1'), 'certs', 'server-cert.pem'), 'utf8')
      );
      assert.ok(chains(
        join(sandbox.root, 'current', 'certs', 'server-cert.pem'),
        join(sandbox.root, 'current', 'ca', 'ca-cert.pem')
      ));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('swaps the whole set in one step and keeps the previous release for rollback', () => {
    const sandbox = createSandbox('okproxy-release-swap-');
    try {
      buildStagedRelease(sandbox.root, 'rel1');
      assert.strictEqual(validate(sandbox.root, 'rel1').status, 0);
      assert.strictEqual(activate(sandbox.root, 'rel1').status, 0);

      // A second release issued by a *different* CA: cert+key+CA must move as one
      // set, so a mixed (new cert / old key) active state is impossible.
      const otherCa = join(sandbox.root, 'other-ca');
      generateCa(otherCa);
      buildStagedRelease(sandbox.root, 'rel2', { caDir: otherCa });
      assert.strictEqual(validate(sandbox.root, 'rel2').status, 0);

      const bootTarget = activeLink(sandbox.root);
      const activated = activate(sandbox.root, 'rel2');
      assert.strictEqual(activated.status, 0, output(activated));
      assert.strictEqual(activeLink(sandbox.root), 'releases/rel2');
      assert.notStrictEqual(activeLink(sandbox.root), bootTarget);

      // The previous release is still on disk and still coherent.
      assert.ok(existsSync(join(releaseDir(sandbox.root, 'rel1'), 'certs', 'server-key.pem')));
      assert.ok(chains(
        join(releaseDir(sandbox.root, 'rel1'), 'certs', 'server-cert.pem'),
        join(releaseDir(sandbox.root, 'rel1'), 'ca', 'ca-cert.pem')
      ));
      assert.ok(activeLink(sandbox.root) !== 'releases/rel1');

      // The active CA is the new one.
      assert.strictEqual(
        readFileSync(join(sandbox.root, 'current', 'ca', 'ca-cert.pem'), 'utf8'),
        readFileSync(join(otherCa, 'ca-cert.pem'), 'utf8')
      );
      // ...and the previous pointer is recorded for recovery.
      assert.strictEqual(
        readFileSync(join(sandbox.root, 'previous-release'), 'utf8').trim(),
        'releases/rel1'
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('records an uploader-supplied previous release and can restore it', () => {
    const sandbox = createSandbox('okproxy-release-prev-');
    try {
      buildStagedRelease(sandbox.root, 'rel1');
      assert.strictEqual(validate(sandbox.root, 'rel1').status, 0);
      assert.strictEqual(activate(sandbox.root, 'rel1').status, 0);

      buildStagedRelease(sandbox.root, 'rel2');
      assert.strictEqual(validate(sandbox.root, 'rel2').status, 0);
      const res = activate(sandbox.root, 'rel2', ['--previous-trust-release=releases/rel1']);
      assert.strictEqual(res.status, 0, output(res));
      assert.strictEqual(
        readFileSync(join(sandbox.root, 'previous-release'), 'utf8').trim(),
        'releases/rel1'
      );

      const restored = runSourced(sandbox.root, `
trust_layout_init
trust_restore_pointer releases/rel1
echo RESTORED
`);
      assert.strictEqual(restored.status, 0, output(restored));
      assert.strictEqual(activeLink(sandbox.root), 'releases/rel1');

      const missing = runSourced(sandbox.root, `
trust_layout_init
trust_restore_pointer releases/does-not-exist
`);
      assert.notStrictEqual(missing.status, 0);
      assert.match(output(missing), /does not exist/);
      assert.strictEqual(activeLink(sandbox.root), 'releases/rel1', 'a failed restore must not move the pointer');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('never activates an incomplete or incoherent staged upload', () => {
    const sandbox = createSandbox('okproxy-release-invalid-');
    try {
      const otherCa = join(sandbox.root, 'other-ca');
      generateCa(otherCa);

      const cases = [
        { id: 'incomplete', opts: { omitKey: true }, message: /incomplete .*missing/i },
        { id: 'mismatched', opts: { corruptKey: true }, message: /key does not match/i },
        { id: 'foreignca', opts: { foreignCaDir: otherCa }, message: /not signed by the staged CA/i },
        { id: 'noca', opts: { omitCa: true }, message: /incomplete .*missing/i }
      ];

      for (const testCase of cases) {
        buildStagedRelease(sandbox.root, testCase.id, testCase.opts);
        const res = validate(sandbox.root, testCase.id);
        assert.notStrictEqual(res.status, 0, `${testCase.id} must be rejected`);
        assert.match(output(res), testCase.message);
        assert.match(output(res), /active (trust )?material (was not modified|untouched)/i);
        assert.ok(!existsSync(join(releaseDir(sandbox.root, testCase.id))), 'nothing may be promoted');
        assert.ok(!existsSync(join(sandbox.root, 'staging', testCase.id, 'READY')),
          'a rejected release must never get a READY marker');
        assert.strictEqual(activeLink(sandbox.root), null, 'the active layout must stay untouched');
      }

      // A release that was never validated (no READY) cannot be activated.
      const manual = releaseDir(sandbox.root, 'manual');
      mkdirSync(join(manual, 'certs'), { recursive: true });
      mkdirSync(join(manual, 'ca'), { recursive: true });
      buildStagedRelease(sandbox.root, 'rel-ok');
      assert.strictEqual(validate(sandbox.root, 'rel-ok').status, 0);
      assert.strictEqual(activate(sandbox.root, 'rel-ok').status, 0);
      const before = activeLink(sandbox.root);

      const refused = activate(sandbox.root, 'manual');
      assert.notStrictEqual(refused.status, 0);
      assert.match(output(refused), /not a complete, coherent, validated set/);
      assert.strictEqual(activeLink(sandbox.root), before, 'the active pointer must not move');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('rejects hostile release ids and leaves validated releases in place on discard', () => {
    const sandbox = createSandbox('okproxy-release-ids-');
    try {
      buildStagedRelease(sandbox.root, 'rel1');
      assert.strictEqual(validate(sandbox.root, 'rel1').status, 0);
      assert.strictEqual(activate(sandbox.root, 'rel1').status, 0);

      const hostile = activate(sandbox.root, '../escape');
      assert.notStrictEqual(hostile.status, 0);
      assert.match(output(hostile), /invalid trust release id/);
      assert.strictEqual(activeLink(sandbox.root), 'releases/rel1');

      // A failed staging directory is discarded; a validated (READY) release is not.
      buildStagedRelease(sandbox.root, 'failed');
      const discarded = runCli(sandbox.root, ['--trust-release-discard=failed']);
      assert.strictEqual(discarded.status, 0, output(discarded));
      assert.ok(!existsSync(join(sandbox.root, 'staging', 'failed')));
      assert.ok(existsSync(join(releaseDir(sandbox.root, 'rel1'), 'READY')),
        'validated releases are rollback history and must not be discarded');
      assert.ok(readdirSync(join(sandbox.root, 'releases')).includes('rel1'));
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('legacy trust directory adoption', () => {
  it('adopts pre-release certs/ca directories without deleting them', () => {
    const sandbox = createSandbox('okproxy-adopt-');
    try {
      // Current-main layout: real certs/ and ca/ directories under DATA_DIR.
      const certsDir = join(sandbox.root, 'certs');
      const caDir = join(sandbox.root, 'ca');
      generateCa(caDir);
      issueServerCert(caDir, certsDir, 'legacy.example.test');
      writeFileSync(join(certsDir, 'ca-cert.pem'), readFileSync(join(caDir, 'ca-cert.pem')));
      const certBefore = sha(join(certsDir, 'server-cert.pem'));

      const res = runSourced(sandbox.root, `
trust_layout_init
bootstrap_trust_release_layout
echo "CERT_DIR=$CERT_DIR"
server_pair_is_coherent "$CERT_DIR" "$CA_DIR" && echo COHERENT
`);
      assert.strictEqual(res.status, 0, output(res));
      assert.match(res.stdout, /Adopting legacy trust directory/);
      assert.match(res.stdout, /COHERENT/);

      const target = activeLink(sandbox.root);
      assert.ok(target && target.startsWith('releases/bootstrap-'), `unexpected pointer: ${target}`);
      // Content preserved bit for bit.
      assert.strictEqual(sha(join(sandbox.root, 'current', 'certs', 'server-cert.pem')), certBefore);
      // Old units reference these exact absolute paths: leave them intact.
      assert.strictEqual(sha(join(certsDir, 'server-cert.pem')), certBefore);
      assert.ok(existsSync(join(caDir, 'ca-cert.pem')));
      assert.ok(!existsSync(join(sandbox.root, 'legacy-layout-backup')));

      // Idempotent: a second run keeps the same pointer.
      const again = runSourced(sandbox.root, `
trust_layout_init
bootstrap_trust_release_layout
echo DONE
`);
      assert.strictEqual(again.status, 0, output(again));
      assert.strictEqual(activeLink(sandbox.root), target, 'bootstrap must be idempotent');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('refuses a non-empty real `current` directory instead of deleting it', () => {
    const sandbox = createSandbox('okproxy-adopt-blocked-');
    try {
      const current = join(sandbox.root, 'current');
      mkdirSync(join(current, 'certs'), { recursive: true });
      writeFileSync(join(current, 'certs', 'server-cert.pem'), 'RECOVERABLE');

      const res = runSourced(sandbox.root, `
trust_layout_init
bootstrap_trust_release_layout
`);
      assert.notStrictEqual(res.status, 0);
      assert.match(output(res), /is a real directory, not the trust release symlink/);
      assert.strictEqual(sha(join(current, 'certs', 'server-cert.pem')), 'RECOVERABLE',
        'recoverable material must not be deleted');
      assert.ok(!isLink(current), 'the directory must be left as-is for the operator');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

// Deliberately invoke bootstrap in an OR list: Bash disables errexit in this
// context, so only explicit mutation checks prevent publication of partial data.
describe('bootstrap fault injection', () => {
  for (const fault of ['cp-fail', 'cp-incomplete', 'mkdir', 'touch', 'ln', 'mv']) {
    it(`does not publish legacy trust after ${fault}`, () => {
      const sandbox = createSandbox('okproxy-copy-fault-');
      try {
        const ca = join(sandbox.root, 'ca');
        const certs = join(sandbox.root, 'certs');
        generateCa(ca);
        issueServerCert(ca, certs, 'legacy.test');
        writeFileSync(join(ca, 'issued-domains.json'), '{"old":true}');
        const oldKey = sha(join(certs, 'server-key.pem'));
        const mock = fault === 'cp-fail' ? 'cp() { return 1; }'
          : fault === 'cp-incomplete'
            ? 'cp() { command cp "$@"; find "$TRUST_RELEASES_DIR" -name issued-domains.json -delete; }'
            : `${fault}() { return 1; }`;
        const res = runSourced(sandbox.root, `
${mock}
bootstrap_trust_release_layout || exit 31
exit 0
`);
        assert.notStrictEqual(res.status, 0, output(res));
        assert.strictEqual(activeLink(sandbox.root), null, 'partial copy must never be active');
        assert.strictEqual(sha(join(certs, 'server-key.pem')), oldKey);
        assert.strictEqual(sha(join(ca, 'issued-domains.json')), '{"old":true}');
      } finally { cleanupSandbox(sandbox); }
    });
  }
});

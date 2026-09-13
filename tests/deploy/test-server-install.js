// Mocked server unit deployment: capture → restart → verify → rollback.
//
// Regression: setup-server-remote.sh replaced the code checkout and the systemd
// unit and then restarted okproxy without checking the result, so a server that
// failed to come up stayed broken with no way back to the previous revision or
// unit. It also "verified" health from log lines produced by earlier runs.
//
// These tests run the real deploy/rollback functions against a throwaway git
// fixture with mocked sudo/systemctl/journalctl/curl. No unit is installed, no
// service is started and no host path is touched.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync, rmSync
} = require('node:fs');
const { join } = require('node:path');
const {
  createSandbox,
  cleanupSandbox,
  writeMock,
  writeSudoMock,
  writeSystemctlMock,
  writeJournalctlMock,
  sourceScript,
  gitRun,
  createFixtureRepo,
  commitFixtureChange,
  generateCa,
  issueServerCert
} = require('./helpers');

const SERVER_SCRIPT = 'scripts/deploy/setup-server-remote.sh';

const PREVIOUS_UNIT = 'PREVIOUS-UNIT-CONTENT\n';
const TUNNEL_MARKER = 'Connected to TLS tunnel server';

function setupFixture({ mode }) {
  const sandbox = createSandbox('okproxy-server-install-');
  writeSudoMock(sandbox);
  writeJournalctlMock(sandbox);

  const healthFile = join(sandbox.log, 'health-ok');
  const logFile = join(sandbox.log, 'okproxy.log');
  const { state } = writeSystemctlMock(sandbox, { logFile, healthFile });

  // Routing has no health endpoint. Never fabricate a successful HTTP probe.
  writeMock(sandbox.bin, 'curl', 'echo "404/502: no health endpoint" >&2; exit 22');
  writeMock(sandbox.bin, 'ss', `if [ -f "${healthFile}" ]; then
    echo 'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=4242,fd=20))'
    echo 'LISTEN 0 511 *:9443 *:* users:(("node",pid=4242,fd=21))'
  fi`);
  for (const tool of ['ssh', 'scp']) writeMock(sandbox.bin, tool, 'exit 111');

  const repo = createFixtureRepo(sandbox);
  const appDir = join(sandbox.root, 'app');
  const trustRoot = join(sandbox.root, 'data');
  mkdirSync(trustRoot, { recursive: true });
  const unitDir = join(sandbox.root, 'systemd');
  mkdirSync(unitDir, { recursive: true });

  return {
    sandbox,
    repo,
    appDir,
    trustRoot,
    healthFile,
    logFile,
    unitPath: join(unitDir, 'okproxy.service'),
    mode,
    systemctl: { state, logFile, healthFile }
  };
}

/** Create a releases/<id> directory and point `current` at it. */
function activateTrustRelease(trustRoot, id, hostname) {
  const release = join(trustRoot, 'releases', id);
  mkdirSync(join(release, 'certs'), { recursive: true });
  mkdirSync(join(release, 'ca'), { recursive: true });
  generateCa(join(release, 'ca'));
  issueServerCert(join(release, 'ca'), join(release, 'certs'), hostname);
  writeFileSync(join(release, 'certs', 'ca-cert.pem'), readFileSync(join(release, 'ca', 'ca-cert.pem')));
  writeFileSync(join(release, 'READY'), '');

  const tmp = join(trustRoot, '.current.tmp');
  rmSync(tmp, { force: true });
  symlinkSync(`releases/${id}`, tmp);
  renameSync(tmp, join(trustRoot, 'current'));
  return release;
}

function currentRelease(trustRoot) {
  const res = require('node:child_process').spawnSync('readlink', [join(trustRoot, 'current')], {
    encoding: 'utf8'
  });
  return (res.stdout || '').trim();
}

/** Clone the fixture repo and advance origin/main so a redeploy has work to do. */
function prepareUpdatePath(fixture) {
  gitRun(['clone', '-q', fixture.repo, fixture.appDir]);
  const prevRev = gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim();
  const newRev = commitFixtureChange(fixture.repo, { content: '// changed\n' });
  writeFileSync(fixture.unitPath, PREVIOUS_UNIT);
  return { prevRev, newRev };
}

function runDeploy(fixture, { newRev = null, extraArgs = [], extraEnv = {} } = {}) {
  const { sandbox, appDir, trustRoot, unitPath } = fixture;
  const resetStep = newRev
    ? 'git -C "$APP_DIR" fetch --quiet origin && git -C "$APP_DIR" reset --hard --quiet "$TEST_NEW_REV"'
    : ': # no checkout exists yet';
  const body = `
APP_DIR="$TEST_APP_DIR"
NODE_PATH="$TEST_NODE"
TRUST_ROOT="$TEST_TRUST_ROOT"
trust_layout_init
CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CA_DIR/ca-cert.pem --ca-dir $CA_DIR"
SERVER_MODE_OPTS="--cert-bound-domains --http-host 127.0.0.1"
capture_previous_checkout_revision
begin_server_transaction
${resetStep}
deploy_server_unit
complete_server_transaction
echo DEPLOY_DONE
`;
  return sourceScript(SERVER_SCRIPT, extraArgs, body, {
    OKPROXY_AS_ROOT: '',
    OKPROXY_SERVER_UNIT_PATH: unitPath,
    OKPROXY_READINESS_ATTEMPTS: '2',
    HOME: sandbox.home,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    MOCK_SYSTEMCTL_MODE: fixture.mode,
    TEST_APP_DIR: appDir,
    TEST_NODE: process.execPath,
    TEST_TRUST_ROOT: trustRoot,
    TEST_NEW_REV: newRev || 'HEAD',
    ...extraEnv
  });
}

function systemctlCalls(fixture) {
  const file = join(fixture.systemctl.state, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function output(res) {
  return `${res.stdout || ''}\n${res.stderr || ''}`;
}

describe('server unit deployment (mocked restart/readiness)', () => {
  it('deploys a fresh install and verifies the current invocation', () => {
    const fixture = setupFixture({ mode: 'ok' });
    try {
      const res = runDeploy(fixture);
      assert.strictEqual(res.status, 0, output(res));
      assert.match(res.stdout, /Waiting for the restarted service to become healthy/);
      assert.match(res.stdout, /configured and healthy/);

      const unit = readFileSync(fixture.unitPath, 'utf8');
      assert.match(unit, /^\[Unit\]/m);
      // Trust paths go through the release symlink, never the old plain dirs.
      assert.ok(unit.includes('/data/current/certs/server-key.pem'), unit);
      assert.ok(!unit.includes('/data/certs/server-key.pem'), unit);

      const calls = systemctlCalls(fixture).join('\n');
      assert.match(calls, /daemon-reload/);
      assert.match(calls, /enable okproxy/);
      assert.match(calls, /restart okproxy/);
      assert.ok(!/No previous unit to restore/.test(res.stdout));
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('restores the previous code revision and unit when the restart fails', () => {
    const fixture = setupFixture({ mode: 'restart-fail' });
    try {
      const { prevRev, newRev } = prepareUpdatePath(fixture);
      const res = runDeploy(fixture, { newRev });

      assert.notStrictEqual(res.status, 0, 'a failed restart must fail the deployment');
      assert.match(output(res), /failed to restart/);
      assert.match(output(res), /Restoring previous code revision/);
      assert.match(output(res), /Restoring previous unit/);

      assert.strictEqual(
        gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(),
        prevRev,
        'the previous code revision must be restored'
      );
      assert.notStrictEqual(gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(), newRev);
      assert.strictEqual(readFileSync(fixture.unitPath, 'utf8'), PREVIOUS_UNIT);
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('restores code, unit and trust pointer on a readiness timeout (no historical logs)', () => {
    const fixture = setupFixture({ mode: 'fail' });
    try {
      const { prevRev, newRev } = prepareUpdatePath(fixture);
      activateTrustRelease(fixture.trustRoot, 'prev-release', 'prev.example.test');
      activateTrustRelease(fixture.trustRoot, 'active-release', 'active.example.test');
      // A historical, healthy-looking log line from the previous deployment must
      // never be accepted as proof that the *current* invocation is healthy.
      writeFileSync(fixture.logFile, `${TUNNEL_MARKER}\n`);

      const res = runDeploy(fixture, {
        newRev,
        extraArgs: ['--previous-trust-release=releases/prev-release']
      });

      assert.notStrictEqual(res.status, 0, 'a readiness timeout must fail the deployment');
      assert.match(output(res), /did not become healthy/);
      assert.match(output(res), /Restoring previous code revision/);
      assert.match(output(res), /Restoring previous unit/);
      assert.match(output(res), /Restoring trust pointer to releases\/prev-release/);

      assert.strictEqual(gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(), prevRev);
      assert.strictEqual(readFileSync(fixture.unitPath, 'utf8'), PREVIOUS_UNIT);
      assert.strictEqual(currentRelease(fixture.trustRoot), 'releases/prev-release',
        'the trust pointer must be rolled back to the pre-deployment release');
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('stops and disables the unit when a fresh install cannot start', () => {
    const fixture = setupFixture({ mode: 'restart-fail' });
    try {
      const res = runDeploy(fixture);
      assert.notStrictEqual(res.status, 0);
      assert.match(output(res), /No previous unit to restore/);

      const calls = systemctlCalls(fixture).join('\n');
      assert.match(calls, /stop okproxy/);
      assert.match(calls, /disable okproxy/);
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });
});

// Independent routing regression: use the real router, not a successful /health
// stub. These listeners bind loopback only and have no tunnel client or target.
describe('readiness is not target routing', () => {
  for (const certBoundDomains of [true, false]) {
    it(`real /health returns ${certBoundDomains ? 404 : 502} without a client`, async () => {
      const { createHTTPServer } = require('../../apps/server/lib/http-router');
      const http = require('node:http');
      const server = createHTTPServer({ count: 0, resolveByHost: () => ({ status: 'unknown' }) }, {}, { certBoundDomains });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const status = await new Promise((resolve, reject) => {
          http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/health', agent: false }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          }).on('error', reject);
        });
        assert.strictEqual(status, certBoundDomains ? 404 : 502);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  }
  it('rejects listeners belonging to a different PID', () => {
    const f = setupFixture({ mode: 'ok' });
    try {
      writeMock(f.sandbox.bin, 'ss', `echo 'LISTEN 0 511 *:8080 *:* users:(("node",pid=14242,fd=20))'
echo 'LISTEN 0 511 *:9443 *:* users:(("node",pid=14242,fd=21))'`);
      assert.notStrictEqual(runDeploy(f).status, 0);
    } finally { cleanupSandbox(f.sandbox); }
  });
});

// Exercise the same encompassing transaction as production, with real local
// checkout, certificates, symlinks and unit files; only privileged operations
// and systemd are mocked. Every original absolute-path unit asset is checked.
describe('transaction faults preserve old absolute unit paths and trust', () => {
  for (const fault of ['permission', 'chmod', 'interruption', 'explicit-exit', 'daemon-fail', 'post-readiness']) {
    it(`restores code/unit/trust on ${fault}`, () => {
      const f = setupFixture({ mode: fault === 'daemon-fail' ? 'daemon-fail' : 'ok' });
      try {
        const { prevRev, newRev } = prepareUpdatePath(f);
        const oldCa = join(f.trustRoot, 'ca');
        const oldCert = join(f.trustRoot, 'certs');
        generateCa(oldCa);
        issueServerCert(oldCa, oldCert, 'old.test');
        const unit = `[Service]\nExecStart=node --key ${oldCert}/server-key.pem --cert ${oldCert}/server-cert.pem --ca ${oldCa}/ca-cert.pem\n`;
        writeFileSync(f.unitPath, unit);
        const oldFiles = ['certs/server-key.pem', 'certs/server-cert.pem', 'ca/ca-cert.pem'];
        const before = oldFiles.map(p => readFileSync(join(f.trustRoot, p), 'utf8'));
        // Build a new validated release, then undo fixture-only activation.
        activateTrustRelease(f.trustRoot, 'new', 'new.test');
        rmSync(join(f.trustRoot, 'current'));
        const calls = join(f.sandbox.log, 'privileged');
        writeMock(f.sandbox.bin, 'sudo', `
echo "$*" >> '${calls}'
case "$1" in
  chown) exit 0 ;;
  chmod) [ "$TEST_FAULT" = chmod ] && exit 1; exec chmod "\${@:2}" ;;
  -u)
    [ "$2" = okproxy ] || exit 111
    [ "$TEST_FAULT" = permission ] && exit 1
    # Validate that the real chmod happened before the readability check.
    [ "$(stat -c %a "$TRUST_ROOT/releases/new")" = 700 ] || exit 1
    exec "\${@:3}" ;;
  systemctl|journalctl|ss|cp|install) exec "$@" ;;
  *) echo 'unexpected privileged command' >&2; exit 111 ;;
esac`);
        const result = sourceScript(SERVER_SCRIPT, ['--deploy-trust-release=new'], `
APP_DIR="$TEST_APP_DIR"
NODE_PATH="$TEST_NODE"
export TRUST_ROOT
begin_server_transaction
initialize_server_trust_layout
printf '%s' "$PREV_TRUST_POINTER" > "$TEST_OLD_POINTER"
git -C "$APP_DIR" fetch --quiet origin
git -C "$APP_DIR" reset --hard --quiet "$TEST_NEW_REV"
prepare_deployment_trust
case "$TEST_FAULT" in
  interruption) kill -TERM $$ ;;
  explicit-exit) exit 19 ;;
esac
CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CA_DIR/ca-cert.pem --ca-dir $CA_DIR"
SERVER_MODE_OPTS=""
deploy_server_unit
[ "$TEST_FAULT" = post-readiness ] && exit 21
complete_server_transaction
`, {
          HOME: f.sandbox.home, PATH: `${f.sandbox.bin}:${process.env.PATH}`,
          TEST_APP_DIR: f.appDir, TEST_NODE: process.execPath, OKPROXY_DATA_DIR: f.trustRoot,
          OKPROXY_AS_ROOT: '', OKPROXY_SERVER_UNIT_PATH: f.unitPath,
          OKPROXY_READINESS_ATTEMPTS: '1', NODE_PATH: process.execPath,
          MOCK_SYSTEMCTL_MODE: f.mode, TEST_FAULT: fault, TEST_NEW_REV: newRev,
          TEST_OLD_POINTER: join(f.sandbox.root, 'old-pointer')
        });
        assert.notStrictEqual(result.status, 0, output(result));
        assert.match(output(result), /Restoring previous code revision/);
        if (fault === 'post-readiness') assert.match(output(result), /configured and healthy/);
        if (fault === 'daemon-fail') assert.match(output(result), /daemon-reload failed/);
        if (['interruption', 'explicit-exit', 'daemon-fail', 'post-readiness'].includes(fault)) {
          assert.match(output(result), /Activated trust release new/);
        }
        assert.strictEqual(gitRun(['rev-parse', 'HEAD'], f.appDir).stdout.trim(), prevRev);
        assert.strictEqual(readFileSync(f.unitPath, 'utf8'), unit);
        assert.strictEqual(currentRelease(f.trustRoot), readFileSync(join(f.sandbox.root, 'old-pointer'), 'utf8'));
        oldFiles.forEach((p, i) => {
          assert.strictEqual(readFileSync(join(f.trustRoot, p), 'utf8'), before[i]);
          assert.strictEqual(readFileSync(join(f.trustRoot, 'current', p), 'utf8'), before[i]);
        });
        assert.ok(!systemctlCalls(f).some(c => /ssh/.test(c)));
      } finally { cleanupSandbox(f.sandbox); }
    });
  }
});

describe('previous checkout capture fails closed', () => {
  for (const fault of ['dubious-ownership', 'config-denied', 'unknown-head']) {
    it(`captures before updates with ${fault}`, () => {
      const f = setupFixture({ mode: 'restart-fail' });
      try {
        const { prevRev, newRev } = prepareUpdatePath(f);
        const realGit = require('node:child_process').spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
        const marker = join(f.sandbox.root, 'safe-configured');
        writeMock(f.sandbox.bin, 'git', `
if [ "$1" = config ]; then
  [ "$TEST_FAULT" = config-denied ] && exit 1
  touch '${marker}'
fi
if [[ "$*" == *rev-parse* ]]; then
  [ -f '${marker}' ] || { echo 'fatal: detected dubious ownership' >&2; exit 128; }
  [ "$TEST_FAULT" = unknown-head ] && exit 128
fi
exec '${realGit}' "$@"`);
        const result = runDeploy(f, { newRev, extraEnv: { TEST_FAULT: fault } });
        assert.notStrictEqual(result.status, 0);
        assert.strictEqual(gitRun(['rev-parse', 'HEAD'], f.appDir).stdout.trim(), prevRev);
        assert.strictEqual(readFileSync(f.unitPath, 'utf8'), PREVIOUS_UNIT);
        if (fault === 'dubious-ownership') assert.match(output(result), /Restoring previous code revision/);
        else assert.strictEqual(systemctlCalls(f).length, 0, 'capture failure must precede service mutation');
      } finally { cleanupSandbox(f.sandbox); }
    });
  }
});

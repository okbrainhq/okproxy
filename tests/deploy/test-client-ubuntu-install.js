// Mocked end-to-end run of the Ubuntu client installer.
//
// The installer is executed for real, but systemctl/loginctl are mocks and HOME
// points into a throwaway sandbox, so no unit is installed and no service is
// started on the host. git/node/chmod/install are real tools operating on
// sandbox paths only. No ssh/scp is involved anywhere in this test.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeSudoMock,
  writeSystemctlMock,
  writeLoginctlMock,
  runInSandbox,
  gitRun,
  createFixtureRepo,
  commitFixtureChange
} = require('./helpers');

const INSTALLER = join(REPO_ROOT, 'scripts', 'deploy', 'setup-client-remote-ubuntu.sh');

function createCertFixture(sandbox) {
  const certDir = join(sandbox.root, 'certs');
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'client-cert.pem'), 'CERT');
  writeFileSync(join(certDir, 'client-key.pem'), 'KEY');
  writeFileSync(join(certDir, 'ca-cert.pem'), 'CA');
  return certDir;
}

function setupInstallerSandbox({ mode }) {
  const sandbox = createSandbox('okproxy-ubuntu-client-');
  writeSudoMock(sandbox);
  writeLoginctlMock(sandbox);

  const logDir = join(sandbox.home, '.okproxy', 'logs', 'test');
  const logFile = join(logDir, 'client.log');
  const { state } = writeSystemctlMock(sandbox, { logFile });

  const repo = createFixtureRepo(sandbox);
  const certDir = createCertFixture(sandbox);
  const appDir = join(sandbox.root, 'app');
  const unitPath = join(sandbox.home, '.config', 'systemd', 'user', 'okproxy-client-test.service');

  return {
    sandbox, repo, certDir, appDir, unitPath, logFile, logDir, mode, systemctl: { state, logFile }
  };
}

/** Create an existing checkout + a newer upstream revision (redeploy path). */
function prepareUpdatePath(fixture) {
  gitRun(['clone', '-q', fixture.repo, fixture.appDir]);
  const prevRev = gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim();
  const newRev = commitFixtureChange(fixture.repo, { content: '// changed\n' });
  assert.notStrictEqual(prevRev, newRev);
  return { prevRev, newRev };
}

function writePreviousUnit(fixture, content = 'PREVIOUS-UNIT-CONTENT\n') {
  mkdirSync(join(fixture.sandbox.home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(fixture.unitPath, content);
  return content;
}

function runInstaller(fixture) {
  const { sandbox, repo, certDir, appDir, logFile, mode } = fixture;
  return runInSandbox(
    sandbox,
    `bash ${JSON.stringify(INSTALLER)} ` +
      `'srv.example.test:9443' 'localhost:3000' ${JSON.stringify(repo)} 'test' ${JSON.stringify(certDir)} 4 ` +
      `--user --app-dir ${JSON.stringify(appDir)} --branch main --node-path ${JSON.stringify(process.execPath)}`,
    {
      env: {
        MOCK_SYSTEMCTL_MODE: mode,
        MOCK_LOG_FILE: logFile,
        OKPROXY_READINESS_ATTEMPTS: '2'
      }
    }
  );
}

function systemctlCalls(fixture) {
  const file = join(fixture.systemctl.state, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('Ubuntu client installer (mocked deployment)', () => {
  it('installs an escaped unit and passes a fresh-invocation readiness check', () => {
    const fixture = setupInstallerSandbox({ mode: 'ok' });
    try {
      // Historical log from a previous deployment must not satisfy readiness.
      mkdirSync(fixture.logDir, { recursive: true });
      writeFileSync(fixture.logFile, 'Connected to TLS tunnel server\n');

      const res = runInstaller(fixture);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /new invocation/);

      assert.ok(existsSync(fixture.unitPath), 'unit file must be written');
      const unit = readFileSync(fixture.unitPath, 'utf8');

      assert.match(unit, /^\[Unit\]/m);
      assert.match(unit, /WantedBy=default\.target/);
      assert.match(unit, /Restart=always/);
      // Node binary is passed as a systemd-quoted token.
      assert.ok(unit.includes(`ExecStart="${process.execPath}" `), unit);
      assert.match(unit, /ReadWritePaths=/);
      assert.ok(unit.includes(fixture.certDir), 'cert dir must be writable');
      assert.ok(unit.includes(fixture.appDir), 'client dir must be writable');
      // No unquoted interpolation leftovers.
      assert.doesNotMatch(unit, /\$\{/);
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('fails and rolls back when the restarted service logs no new connection', () => {
    const fixture = setupInstallerSandbox({ mode: 'fail' });
    try {
      // Pre-existing good unit + historical log: the redeploy must not accept
      // the historical line as proof of health.
      writePreviousUnit(fixture);
      mkdirSync(fixture.logDir, { recursive: true });
      writeFileSync(fixture.logFile, 'Connected to TLS tunnel server\n');

      const res = runInstaller(fixture);
      assert.notStrictEqual(res.status, 0, 'installer must fail when readiness is not met');
      const output = `${res.stdout}\n${res.stderr}`;
      assert.match(output, /did not become healthy/);
      assert.match(output, /Restoring previous unit/);

      // Rollback restored the previously installed unit.
      assert.strictEqual(readFileSync(fixture.unitPath, 'utf8'), 'PREVIOUS-UNIT-CONTENT\n');
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('rolls back the code revision when the restart itself fails (set -e must not skip rollback)', () => {
    const fixture = setupInstallerSandbox({ mode: 'restart-fail' });
    try {
      const { prevRev, newRev } = prepareUpdatePath(fixture);
      writePreviousUnit(fixture);
      mkdirSync(fixture.logDir, { recursive: true });
      writeFileSync(fixture.logFile, 'Connected to TLS tunnel server\n');

      const res = runInstaller(fixture);

      assert.notStrictEqual(res.status, 0, 'a failed restart must fail the deploy');
      const output = `${res.stdout}\n${res.stderr}`;
      assert.match(output, /failed to restart/);
      assert.match(output, /Restoring previous code revision/);
      assert.match(output, /Restoring previous unit/);

      assert.strictEqual(
        gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(),
        prevRev,
        'the previous code revision must be restored (not left on the new one)'
      );
      assert.notStrictEqual(
        gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(),
        newRev
      );
      assert.strictEqual(readFileSync(fixture.unitPath, 'utf8'), 'PREVIOUS-UNIT-CONTENT\n');
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('rolls back the code revision on a readiness timeout', () => {
    const fixture = setupInstallerSandbox({ mode: 'fail' });
    try {
      const { prevRev } = prepareUpdatePath(fixture);
      writePreviousUnit(fixture);
      mkdirSync(fixture.logDir, { recursive: true });
      writeFileSync(fixture.logFile, 'Connected to TLS tunnel server\n');

      const res = runInstaller(fixture);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}\n${res.stderr}`, /did not become healthy/);
      assert.strictEqual(
        gitRun(['rev-parse', 'HEAD'], fixture.appDir).stdout.trim(),
        prevRev,
        'a readiness timeout must also restore the previous code revision'
      );
      assert.strictEqual(readFileSync(fixture.unitPath, 'utf8'), 'PREVIOUS-UNIT-CONTENT\n');
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });

  it('stops and disables the unit when a fresh install cannot start', () => {
    const fixture = setupInstallerSandbox({ mode: 'restart-fail' });
    try {
      // No previous unit: a failed first install must not leave a boot loop.
      const res = runInstaller(fixture);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}\n${res.stderr}`, /No previous unit to restore/);

      const calls = systemctlCalls(fixture).join('\n');
      assert.match(calls, /stop/);
      assert.match(calls, /disable/);
    } finally {
      cleanupSandbox(fixture.sandbox);
    }
  });
});

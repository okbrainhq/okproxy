// Robust boolean flag parsing + orchestrator forwarding.
//
// Regression: `--cert-bound-domains false` used to be consumed as `true` while
// `false` leaked into the positional arguments, silently turning a classic
// deployment into a cert-bound one (and shifting HOSTNAME/REPO_URL).

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeRemoteMocks,
  writeSudoMock,
  readRemoteLog,
  sourceScript,
  executeCapturedRemoteCommand
} = require('./helpers');

const SERVER_SCRIPT = 'scripts/deploy/setup-server-remote.sh';

function parseArgs(args) {
  return sourceScript(SERVER_SCRIPT, args, `
echo "CERT_BOUND_DOMAINS=\${CERT_BOUND_DOMAINS}"
echo "POSITIONAL_COUNT=\${#POSITIONAL[@]}"
echo "POSITIONAL=\${POSITIONAL[*]}"
echo "BRANCH=\${BRANCH}"
echo "SSH_PORT=\${SSH_PORT:-}"
`);
}

describe('remote boolean flag parsing', () => {
  it('accepts a detached false value without consuming positionals', () => {
    const res = parseArgs(['myhost.example.test', 'https://example.test/repo.git', '--cert-bound-domains', 'false']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /CERT_BOUND_DOMAINS=false/);
    assert.match(res.stdout, /POSITIONAL_COUNT=2/);
    assert.match(res.stdout, /POSITIONAL=myhost\.example\.test https:\/\/example\.test\/repo\.git/);
  });

  it('accepts --cert-bound-domains=false', () => {
    const res = parseArgs(['--cert-bound-domains=false']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /CERT_BOUND_DOMAINS=false/);
  });

  it('accepts a bare --cert-bound-domains as true', () => {
    const res = parseArgs(['--cert-bound-domains']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /CERT_BOUND_DOMAINS=true/);
  });

  it('fails closed on a bogus boolean value instead of shifting positionals', () => {
    const res = parseArgs(['myhost', 'https://example.test/repo.git', '--cert-bound-domains', 'maybe']);
    assert.notStrictEqual(res.status, 0);
    assert.match(`${res.stdout}${res.stderr}`, /expects true or false/);
  });

  it('fails closed on a bogus --cert-bound-domains= value', () => {
    const res = parseArgs(['--cert-bound-domains=1']);
    assert.notStrictEqual(res.status, 0);
    assert.match(`${res.stdout}${res.stderr}`, /expects true or false/);
  });

  it('keeps other flags working alongside the boolean', () => {
    const res = parseArgs([
      '--branch', 'release/x', '--cert-bound-domains', 'false', '--ssh-port', '2222'
    ]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /CERT_BOUND_DOMAINS=false/);
    assert.match(res.stdout, /BRANCH=release\/x/);
    assert.match(res.stdout, /SSH_PORT=2222/);
  });
});

describe('setup-server.sh flag forwarding', () => {
  function runOrchestrator(sandbox, deployConfig) {
    const proj = join(sandbox.root, 'proj');
    mkdirSync(join(proj, 'scripts', 'deploy'), { recursive: true });
    copyFileSync(
      join(REPO_ROOT, 'scripts', 'deploy', 'setup-server.sh'),
      join(proj, 'scripts', 'deploy', 'setup-server.sh')
    );
    writeFileSync(join(proj, '.deploy.server'), deployConfig);
    const { spawnSync } = require('node:child_process');
    return spawnSync('bash', ['scripts/deploy/setup-server.sh'], {
      cwd: proj,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: sandbox.home,
        PATH: `${sandbox.bin}:${process.env.PATH}`
      }
    });
  }

  it('forwards --cert-bound-domains=false as a single token', () => {
    const sandbox = createSandbox('okproxy-flags-');
    try {
      const { logFile } = writeRemoteMocks(sandbox);
      writeSudoMock(sandbox);

      const res = runOrchestrator(sandbox, [
        "HOSTNAME='srv.example.test'",
        "REPO_URL='https://example.test/repo.git'",
        "BRANCH='main'",
        "DEPLOY_HOST='deploy@example.test'",
        "CERT_BOUND_DOMAINS='false'",
        ''
      ].join('\n'));
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      const entries = readRemoteLog(logFile).filter((entry) => entry.tool === 'ssh');
      assert.ok(entries.length > 0, 'expected an ssh invocation to be recorded');
      const command = entries[entries.length - 1].args.slice(-1)[0];
      assert.match(command, /--cert-bound-domains=false( |$)/);
      assert.doesNotMatch(command, /--cert-bound-domains false( |$)/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('rejects a non-boolean CERT_BOUND_DOMAINS locally', () => {
    const sandbox = createSandbox('okproxy-flags-bad-');
    try {
      writeRemoteMocks(sandbox);
      writeSudoMock(sandbox);
      const res = runOrchestrator(sandbox, [
        "HOSTNAME='srv.example.test'",
        "REPO_URL='https://example.test/repo.git'",
        "BRANCH='main'",
        "DEPLOY_HOST='deploy@example.test'",
        "CERT_BOUND_DOMAINS='yes-please'",
        ''
      ].join('\n'));
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /CERT_BOUND_DOMAINS must be true or false/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('propagates the boolean value the remote script actually parses', () => {
    const sandbox = createSandbox('okproxy-flags-behaviour-');
    try {
      const { logFile } = writeRemoteMocks(sandbox);
      writeSudoMock(sandbox);

      const res = runOrchestrator(sandbox, [
        "HOSTNAME='srv.example.test'",
        "REPO_URL='https://example.test/repo.git'",
        "BRANCH='main'",
        "DEPLOY_HOST='deploy@example.test'",
        "CERT_BOUND_DOMAINS='false'",
        ''
      ].join('\n'));
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      const command = readRemoteLog(logFile)
        .filter((entry) => entry.tool === 'ssh')
        .slice(-1)[0].args.slice(-1)[0];

      const argLog = join(sandbox.log, 'remote-args.txt');
      const executed = executeCapturedRemoteCommand(sandbox, command, {
        scriptName: 'setup-server-remote.sh',
        argLogFile: argLog
      });
      assert.strictEqual(executed.status, 0, executed.stderr);

      const args = readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
      assert.deepStrictEqual(args, [
        'srv.example.test',
        'https://example.test/repo.git',
        '--branch',
        'main',
        '--cert-bound-domains=false'
      ]);
      assert.ok(existsSync(argLog));
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

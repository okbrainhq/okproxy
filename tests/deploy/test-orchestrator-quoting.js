// Orchestrator quoting tests.
//
// The local scripts (setup-server.sh / setup-client.sh) build a remote command
// string for ssh. This test feeds them hostile values (shell metacharacters,
// command substitution) and then *executes the captured remote command locally
// against stubs*: if the quoting were broken, the injected command would run
// and create a canary file. Nothing else is executed (ssh/scp are mocked).

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeRemoteMocks,
  writeSudoMock,
  readRemoteLog,
  runInSandbox,
  executeCapturedRemoteCommand
} = require('./helpers');

function copyScript(projDir, name) {
  mkdirSync(join(projDir, 'scripts', 'deploy'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'scripts', 'deploy', name),
    join(projDir, 'scripts', 'deploy', name)
  );
}

function lastRemoteCommand(entries) {
  const sshEntries = entries.filter(e => e.tool === 'ssh');
  assert.ok(sshEntries.length > 0, 'expected at least one ssh invocation');
  const last = sshEntries[sshEntries.length - 1];
  return last.args[last.args.length - 1];
}

describe('setup-server.sh remote argument quoting', () => {
  it('does not execute injected shell syntax from .deploy.server', () => {
    const sandbox = createSandbox('okproxy-orch-server-');
    try {
      writeRemoteMocks(sandbox);
      writeSudoMock(sandbox);

      const canary = join(sandbox.root, 'canary-server');
      const repocanary = join(sandbox.root, 'canary-repo');
      const hostileHostname = `evil; touch ${canary}`;
      const hostileRepo = `https://example.test/repo.git$(touch ${repocanary})`;

      const proj = join(sandbox.root, 'proj');
      copyScript(proj, 'setup-server.sh');
      writeFileSync(join(proj, '.deploy.server'),
        `HOSTNAME='${hostileHostname}'\nREPO_URL='${hostileRepo}'\nBRANCH=main\nDEPLOY_HOST=deploy@example.test\n`);

      const res = runInSandbox(sandbox, 'bash scripts/deploy/setup-server.sh', { cwd: proj });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      assert.ok(!existsSync(canary), 'HOSTNAME injection must not execute');
      assert.ok(!existsSync(repocanary), 'REPO_URL injection must not execute');

      const cmd = lastRemoteCommand(readRemoteLog(join(sandbox.log, 'remote.log')));
      const argLog = join(sandbox.root, 'server-remote-args.txt');
      const exec = executeCapturedRemoteCommand(sandbox, cmd, {
        scriptName: 'setup-server-remote.sh',
        argLogFile: argLog
      });
      assert.strictEqual(exec.status, 0, exec.stderr || exec.stdout);

      const args = readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(args[0], hostileHostname, 'hostname must arrive as one literal argument');
      assert.strictEqual(args[1], hostileRepo, 'repo url must arrive as one literal argument');
      assert.deepStrictEqual(args.slice(2), ['--branch', 'main', '--cert-bound-domains=true']);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('setup-client.sh remote argument quoting', () => {
  it('resolves ~ and sanitizes the client name without executing injection', () => {
    const sandbox = createSandbox('okproxy-orch-client-');
    try {
      writeRemoteMocks(sandbox, { remoteHome: '/home/tester' });
      writeSudoMock(sandbox);

      const canary = join(sandbox.root, 'canary-client');
      const proj = join(sandbox.root, 'proj');
      copyScript(proj, 'setup-client.sh');
      writeFileSync(join(proj, '.deploy.client'),
        `SERVER_HOST='srv.example.test:9443'\n` +
        `TARGET_HOST='localhost:3000'\n` +
        `REPO_URL='https://example.test/repo.git'\n` +
        `CLIENT_NAME='evil; touch ${canary}'\n`);

      const res = runInSandbox(sandbox,
        'bash scripts/deploy/setup-client.sh deploy@example.test --platform linux',
        { cwd: proj });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      assert.ok(!existsSync(canary), 'CLIENT_NAME injection must not execute');

      const entries = readRemoteLog(join(sandbox.log, 'remote.log'));
      assert.ok(
        entries.some(e => e.args.some(a => a.includes('printf %s "$HOME"'))),
        'the tilde in the remote cert dir must be resolved through a real remote query'
      );

      const cmd = lastRemoteCommand(entries);
      const argLog = join(sandbox.root, 'client-remote-args.txt');
      const exec = executeCapturedRemoteCommand(sandbox, cmd, {
        scriptName: 'setup-client-remote-ubuntu.sh',
        argLogFile: argLog
      });
      assert.strictEqual(exec.status, 0, exec.stderr || exec.stdout);

      const args = readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(args[0], 'srv.example.test:9443');
      assert.strictEqual(args[1], 'localhost:3000');
      assert.strictEqual(args[2], 'https://example.test/repo.git');
      assert.doesNotMatch(args[3], /[;\s]/, 'client name must be sanitized');
      assert.match(args[3], /^evil/);
      assert.ok(args[4].startsWith('/home/tester/.okproxy/certs/'),
        `remote cert dir must be an absolute resolved path, got: ${args[4]}`);
      assert.doesNotMatch(args[4], /~/, 'remote cert dir must not contain a literal ~');
      assert.strictEqual(args[5], '4');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

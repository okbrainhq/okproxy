// Mocked run of the macOS client installer to validate LaunchAgent (plist) XML
// serialization. launchctl is mocked and HOME points into a sandbox, so no
// agent is loaded on the host.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeMock,
  runInSandbox
} = require('./helpers');

const INSTALLER = join(REPO_ROOT, 'scripts', 'deploy', 'setup-client-remote.sh');

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'deploy-test',
      GIT_AUTHOR_EMAIL: 'deploy-test@example.test',
      GIT_COMMITTER_NAME: 'deploy-test',
      GIT_COMMITTER_EMAIL: 'deploy-test@example.test'
    }
  });
}

describe('macOS client installer plist escaping (mocked)', () => {
  it('escapes XML metacharacters from target host values', () => {
    const sandbox = createSandbox('okproxy-plist-');
    try {
      // Mock launchctl: report a loaded agent with a PID so the script proceeds.
      writeMock(sandbox.bin, 'launchctl', `
case "$1" in
  list) printf '"PID" = 4242;\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`);

      const repo = join(sandbox.root, 'repo');
      mkdirSync(join(repo, 'apps', 'client'), { recursive: true });
      writeFileSync(join(repo, 'apps', 'client', 'index.js'), '// stub client\n');
      let res = git(['init', '-q', '-b', 'main'], repo);
      if (res.status !== 0) {
        git(['init', '-q'], repo);
        git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
      }
      git(['add', '-A'], repo);
      res = git(['commit', '-q', '-m', 'init'], repo);
      assert.strictEqual(res.status, 0, res.stderr);

      const certDir = join(sandbox.root, 'certs');
      mkdirSync(certDir, { recursive: true });
      writeFileSync(join(certDir, 'client-cert.pem'), 'CERT');
      writeFileSync(join(certDir, 'client-key.pem'), 'KEY');
      writeFileSync(join(certDir, 'ca-cert.pem'), 'CA');

      mkdirSync(join(sandbox.home, 'Library', 'LaunchAgents'), { recursive: true });

      const hostileTarget = "localhost&'x:3000";
      const run = runInSandbox(
        sandbox,
        `bash ${JSON.stringify(INSTALLER)} 'srv.example.test:9443' ${JSON.stringify(hostileTarget)} ` +
          `${JSON.stringify(repo)} 'testprofile' ${JSON.stringify(certDir)} 4`,
        { env: { OKPROXY_NODE_PATH: process.execPath } }
      );
      assert.strictEqual(run.status, 0, run.stderr || run.stdout);

      const plistPath = join(sandbox.home, 'Library', 'LaunchAgents', 'com.okproxy.client.testprofile.plist');
      assert.ok(existsSync(plistPath), 'plist must be written');
      const plist = readFileSync(plistPath, 'utf8');

      assert.match(plist, /<string>localhost&amp;&apos;x:3000<\/string>/);
      assert.ok(!plist.includes("localhost&'x:3000"), 'raw metacharacters must not appear');
      assert.match(plist, /<key>ProgramArguments<\/key>/);
      assert.match(plist, /<key>StandardOutPath<\/key>/);
      // Balanced plist skeleton.
      assert.strictEqual((plist.match(/<plist /g) || []).length, 1);
      assert.strictEqual((plist.match(/<\/plist>/g) || []).length, 1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

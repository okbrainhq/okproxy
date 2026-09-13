// Escaping helpers used by the deployment scripts must be safe and stable.
// Each script can be sourced with OKPROXY_DEPLOY_SOURCE_ONLY=1, which stops
// execution right after the pure helpers are defined.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { REPO_ROOT } = require('./helpers');

function runSourced(scriptRelPath, body) {
  const script = join(REPO_ROOT, scriptRelPath);
  return spawnSync('bash', ['-c', `source "$1"\n${body}`, 'bash', script], {
    encoding: 'utf8',
    env: { ...process.env, OKPROXY_DEPLOY_SOURCE_ONLY: '1' }
  });
}

describe('deployment escaping helpers', () => {
  it('setup-server-remote.sh stops after helpers when sourced', () => {
    // Production mode requires 2 positional args; the source-only guard must
    // short-circuit before that validation.
    const res = runSourced('scripts/deploy/setup-server-remote.sh', 'echo SOURCED');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /SOURCED/);
  });

  it('systemd_escape_arg serializes $ literally (no PID expansion)', () => {
    const res = runSourced('scripts/deploy/setup-server-remote.sh',
      `systemd_escape_arg 'a$b'; echo; systemd_escape_arg 'a$b'`);
    assert.strictEqual(res.status, 0, res.stderr);
    const [first, second] = res.stdout.trim().split('\n');
    assert.strictEqual(first, '"a$$b"');
    assert.strictEqual(first, second, 'escaping must be deterministic, not PID-dependent');
  });

  it('systemd_escape_arg escapes quotes, backslashes and percent', () => {
    const res = runSourced('scripts/deploy/setup-server-remote.sh',
      'systemd_escape_arg \'a\\b"c%d\'');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, '"a\\\\b\\"c%%d"');
  });

  it('systemd_escape_value flattens newlines and doubles percent', () => {
    const res = runSourced('scripts/deploy/setup-server-remote.sh',
      `systemd_escape_value $'line1\\nline2%'; echo`);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, 'line1 line2%%\n');
  });

  it('client ubuntu systemd_escape_path quotes only when needed', () => {
    const res = runSourced('scripts/deploy/setup-client-remote-ubuntu.sh',
      'systemd_escape_path "/home/u/log"; echo; systemd_escape_path "/home/u/my log"; echo; systemd_escape_path "/home/u/100%"; echo');
    assert.strictEqual(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    assert.strictEqual(lines[0], '/home/u/log');
    assert.strictEqual(lines[1], '"/home/u/my log"');
    assert.strictEqual(lines[2], '/home/u/100%%');
  });

  it('macOS plist xml_escape escapes XML metacharacters', () => {
    const res = runSourced('scripts/deploy/setup-client-remote.sh',
      `xml_escape 'a&b<c>d"e'"'"'f'; echo`);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, 'a&amp;b&lt;c&gt;d&quot;e&apos;f\n');
  });
});

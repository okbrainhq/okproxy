// Server systemd unit rendering + static safety checks for the destructive
// parts of setup-server-remote.sh (no host is touched; the unit is only
// rendered to stdout).

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { REPO_ROOT, createSandbox, cleanupSandbox } = require('./helpers');

const SERVER_SCRIPT = join(REPO_ROOT, 'scripts', 'deploy', 'setup-server-remote.sh');

function renderUnit(extraEnv) {
  return spawnSync('bash', ['-c', `source "$1"
CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CA_DIR/ca-cert.pem --ca-dir $CA_DIR"
SERVER_MODE_OPTS="--cert-bound-domains --http-host 127.0.0.1"
NODE_PATH="\${TEST_NODE_PATH:-/usr/local/bin/node}"
APP_DIR="\${TEST_APP_DIR:-/opt/okproxy}"
render_okproxy_unit`, 'bash', SERVER_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, OKPROXY_DEPLOY_SOURCE_ONLY: '1', ...extraEnv }
  });
}

describe('server systemd unit', () => {
  it('writes state outside the checkout and only lists required/optional writable paths', () => {
    const res = renderUnit({ TEST_APP_DIR: '/opt/okproxy' });
    assert.strictEqual(res.status, 0, res.stderr);

    // Trust material is read from the persistent data dir, never from /opt/okproxy.
    // The active set is one release referenced through the `current` symlink.
    assert.match(res.stdout, /ReadWritePaths=\/var\/lib\/okproxy\/current\/certs \/var\/lib\/okproxy\/current\/ca -\/opt\/okproxy\/\.certs -\/opt\/okproxy\/\.ca/);
    assert.match(res.stdout, /--key \/var\/lib\/okproxy\/current\/certs\/server-key\.pem/);
    assert.match(res.stdout, /--cert \/var\/lib\/okproxy\/current\/certs\/server-cert\.pem/);
    assert.match(res.stdout, /--ca \/var\/lib\/okproxy\/current\/ca\/ca-cert\.pem/);
    assert.doesNotMatch(res.stdout, /ReadWritePaths=[^\n]*\/opt\/okproxy\/certs/);
  });

  it('lists existing legacy writable paths without the ignore-if-missing prefix', () => {
    const sandbox = createSandbox('okproxy-unit-');
    try {
      const appDir = join(sandbox.root, 'app');
      mkdirSync(join(appDir, '.certs'), { recursive: true });
      const res = renderUnit({ TEST_APP_DIR: appDir });
      assert.strictEqual(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`ReadWritePaths=.* ${appDir}/\\.certs`));
      assert.doesNotMatch(res.stdout, new RegExp(`-${appDir}/\\.certs`));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('quotes the node binary path in ExecStart', () => {
    const res = renderUnit({ TEST_NODE_PATH: '/opt/node bin/my%node' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /ExecStart="\/opt\/node bin\/my%%node" apps\/server\/index\.js/);
  });
});

describe('server deploy script destructive-path safety', () => {
  const source = readFileSync(SERVER_SCRIPT, 'utf8');

  it('never chowns the parent of the app directory recursively', () => {
    assert.doesNotMatch(source, /chown -R[^\n]*\$\(dirname/);
    assert.doesNotMatch(source, /chown -R[^\n]*\/opt\/okproxy[^\n]*\bchown/);
    // /opt itself must never be a recursive chown target.
    assert.doesNotMatch(source, /chown -R[^\n]*\s\/opt\s*$/m);
  });

  it('migrates legacy trust material before any checkout removal', () => {
    const migrateIdx = source.indexOf('migrate_legacy_trust_material()');
    const callIdx = source.indexOf('migrate_legacy_trust_material\n');
    const rmIdx = source.indexOf('sudo rm -rf "$APP_DIR"');
    assert.ok(migrateIdx > -1, 'migration helper must exist');
    assert.ok(callIdx > -1, 'migration helper must be called');
    assert.ok(rmIdx > -1, 'checkout removal must exist');
    assert.ok(source.indexOf('migrate_legacy_trust_material\n', migrateIdx) < rmIdx,
      'migration must run before the checkout is removed');
  });

  it('refuses to delete unknown non-git contents and keeps trust material in /var/lib/okproxy', () => {
    assert.match(source, /legacy_app_dir_is_safe_to_replace/);
    assert.match(source, /Refusing to delete it/);
    assert.match(source, /DATA_DIR="\$\{OKPROXY_DATA_DIR:-\/var\/lib\/okproxy\}"/);
    assert.match(source, /TRUST_ACTIVE_LINK="\$TRUST_ROOT\/current"/);
    assert.match(source, /CERT_DIR="\$TRUST_ACTIVE_LINK\/certs"/);
    assert.match(source, /CA_DIR="\$TRUST_ACTIVE_LINK\/ca"/);
  });

  it('allows only the verified management port and fails closed on unknown/denied ports', () => {
    assert.match(source, /MANAGEMENT_PORTS="\$\(detect_management_ports\)"/);
    assert.match(source, /MGMT_ALLOW=""/);
    assert.match(source, /apply_firewall_rules "\$MGMT_ALLOW"/);
    assert.match(source, /ufw show added/);
    assert.match(source, /Refusing to enable UFW/);
    assert.match(source, /--ssh-port/);
    // No unconditional port-22 fallback.
    assert.doesNotMatch(source, /MANAGEMENT_PORTS="22"/);
    assert.doesNotMatch(source, /MGMT_ALLOW="22"/);
  });
});

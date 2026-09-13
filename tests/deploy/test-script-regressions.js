// Static regression guards for the audited deployment fixes. These assert the
// shape of the scripts (cheap, deterministic) and complement the behavioural
// mocked tests.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { REPO_ROOT } = require('./helpers');

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('deployment script regressions', () => {
  it('server orchestrator uploads trust material outside the checkout and forwards the SSH port', () => {
    const src = read('scripts/deploy/setup-server.sh');
    assert.match(src, /DATA_DIR="\/var\/lib\/okproxy"/);
    assert.match(src, /CERT_DIR="\$DATA_DIR\/certs"/);
    assert.match(src, /CA_DIR="\$DATA_DIR\/ca"/);
    assert.match(src, /SSH_PORT_ARG/);
    assert.match(src, /--ssh-port/);
    // The old recursive chown of the deploy root must be gone.
    assert.doesNotMatch(src, /chown -R \\"\$USER:\\\$USER\\" \/opt\/okproxy/);
  });

  it('forwards the boolean flag as a single --flag=value token', () => {
    const src = read('scripts/deploy/setup-server.sh');
    assert.match(src, /CERT_BOUND_ARG=\$\(printf '%q' "--cert-bound-domains=\$CERT_BOUND_DOMAINS"\)/);
    assert.doesNotMatch(src, /--cert-bound-domains \$ESCAPED_CERT_BOUND_DOMAINS/);
    // Local validation of the boolean value.
    assert.match(src, /CERT_BOUND_DOMAINS must be true or false/);
  });

  it('server remote script never regenerates an existing CA', () => {
    const src = read('scripts/deploy/setup-server-remote.sh');
    assert.match(src, /ensure_server_trust_set\(\)/);
    assert.match(src, /Refusing to regenerate the CA/);
    // `init` may only run in the branch where no CA exists at all.
    const initCalls = src.match(/tunnel-ca\.js init/g) || [];
    assert.strictEqual(initCalls.length, 1);
    assert.match(src, /server_pair_is_coherent\(\)/);
    assert.match(src, /cert_signed_by_ca\(\)/);
    assert.match(src, /key_matches_cert\(\)/);
  });

  it('migration keeps the historical precedence and never guesses a CA', () => {
    const src = read('scripts/deploy/setup-server-remote.sh');
    const uploaded = src.indexOf('"$APP_DIR/certs" "$APP_DIR/.certs"');
    assert.ok(uploaded > 0, 'expected the historical precedence order to be spelled out');
    assert.match(src, /migrate_legacy_trust_material\(\)/);
    assert.match(src, /Refusing to guess which CA the existing clients trust/);
    assert.match(src, /two different CAs are present/);
    // No privileged hardcoding: tests can neutralise it.
    assert.match(src, /AS_ROOT="\$\{OKPROXY_AS_ROOT-sudo\}"/);
    assert.doesNotMatch(src, /chown -R "\$REAL_USER":"\$REAL_USER" "\$\(dirname/);
  });

  it('firewall validation is fail-closed and never assumes port 22', () => {
    const src = read('scripts/deploy/setup-server-remote.sh');
    assert.match(src, /detect_management_ports\(\)/);
    assert.match(src, /firewall_precheck\(\)/);
    // Any deny/reject rule aborts; no per-port deny parsing (unprovable).
    assert.match(src, /ufw_deny_lines\(\)/);
    assert.match(src, /cannot be proven safe/);
    assert.match(src, /Refusing to enable UFW/);
    // Ranges and other non-exact allow forms are not interpreted.
    assert.match(src, /is not allowed by an exact UFW rule/);
    // No unconditional 22 fallback.
    assert.doesNotMatch(src, /MANAGEMENT_PORTS="22"/);
    assert.doesNotMatch(src, /MGMT_ALLOW="22"/);
    assert.doesNotMatch(src, /ufw_denied_tcp_ports/);
    // Ordering: mutations live in apply_firewall_rules(), which allows the
    // management ports before applying the restrictive incoming default.
    assert.match(src, /apply_firewall_rules\(\)/);
    assert.match(src, /FIREWALL_ERROR="\$\(apply_firewall_rules/);
    assert.ok(
      src.indexOf('$AS_ROOT ufw default deny incoming') > src.indexOf('$AS_ROOT ufw allow "$port/tcp"'),
      'the restrictive default must be applied after the management allowance'
    );
    assert.ok(
      src.indexOf('$AS_ROOT ufw --force enable') > src.indexOf('$AS_ROOT ufw default deny incoming'),
      'enable must come after the defaults'
    );
    // The production block must not mutate ufw directly any more.
    assert.doesNotMatch(src, /^    sudo ufw (default|allow|--force)/m);
  });

  it('initialises trust material only when the state is genuinely empty', () => {
    const src = read('scripts/deploy/setup-server-remote.sh');
    assert.match(src, /trust_dirs_empty\(\)/);
    assert.match(src, /ls -A "\$dir"/);
    assert.match(src, /Refusing to initialise a new CA/);
    // Exactly one init call, guarded by the emptiness check.
    const initCalls = src.match(/tunnel-ca\.js init/g) || [];
    assert.strictEqual(initCalls.length, 1, '`init` must appear exactly once');
    const guardIdx = src.indexOf('trust_dirs_empty; then');
    const initIdx = src.indexOf('tunnel-ca.js init');
    assert.ok(guardIdx > 0 && guardIdx < initIdx, 'init must be gated by the emptiness check');
  });

  it('ubuntu client installer restarts explicitly and verifies a fresh invocation', () => {
    const src = read('scripts/deploy/setup-client-remote-ubuntu.sh');
    assert.match(src, /if ! \$SYSTEMCTL restart "\$SERVICE_NAME"; then/);
    assert.match(src, /RESTART_OK=false/);
    assert.match(src, /show -p InvocationID --value/);
    assert.match(src, /LOG_OFFSET/);
    assert.match(src, /tail -c \+/);
    // enable --now must not be used for the restart path (it does not restart).
    assert.doesNotMatch(src, /enable --now "\$SERVICE_NAME"/);
    // A failing restart must not bypass rollback through `set -e`.
    assert.doesNotMatch(src, /^\s*\$SYSTEMCTL restart "\$SERVICE_NAME"$/m);
  });

  it('ubuntu client installer rolls back code and unit on any failed deploy', () => {
    const src = read('scripts/deploy/setup-client-remote-ubuntu.sh');
    assert.match(src, /rollback_release\(\)/);
    assert.match(src, /PREV_CODE_REV=/);
    assert.match(src, /git -C "\$APP_DIR" reset --hard --quiet "\$PREV_CODE_REV"/);
    assert.match(src, /Restoring previous unit from/);
    assert.match(src, /disable "\$SERVICE_NAME"/);
    assert.match(src, /rollback_release "\$\{SERVICE_NAME\} did not become healthy/);
    assert.match(src, /rollback_release "\$\{SERVICE_NAME\} failed to restart"/);
  });

  it('macOS installer escapes every plist interpolation', () => {
    const src = read('scripts/deploy/setup-client-remote.sh');
    assert.match(src, /xml_escape\(\)/);
    assert.match(src, /PLIST_LABEL="\$\(xml_escape/);
    assert.match(src, /PLIST_SERVER="\$\(xml_escape/);
    assert.match(src, /PLIST_TARGET="\$\(xml_escape/);
    assert.match(src, /PLIST_CLIENT_CERT="\$\(xml_escape/);
    assert.match(src, /PLIST_LOG_DIR="\$\(xml_escape/);
    // Values inside the heredoc are the escaped ones, never the raw inputs.
    const plistStart = src.indexOf('cat > "$PLIST_PATH"');
    assert.ok(plistStart > 0);
    const plistBlock = src.slice(plistStart);
    assert.doesNotMatch(plistBlock, /\$\{SERVER_HOSTNAME\}/);
    assert.doesNotMatch(plistBlock, /\$\{TARGET_HOSTNAME\}/);
    assert.doesNotMatch(plistBlock, /\$\{CLIENT_DIR\}/);
  });

  it('runners include the CLI unit suites and fail on gzip coverage loss', () => {
    for (const runner of ['tests/e2e/tls-mtls/run.js', 'tests/e2e/tls-mtls/run-all.js']) {
      const src = read(runner);
      assert.match(src, /test-parse-args\.js/, `${runner} must include the CLI unit tests`);
      assert.match(src, /test-gzip-step\.js/, `${runner} must include the gzip-step unit tests`);
      assert.match(src, /lib\/gzip-step/, `${runner} must run the gzip suite via the shared step`);
      assert.match(src, /OKPROXY_ALLOW_GZIP_SKIP/, `${runner} must require explicit gzip skip opt-in`);
    }
    const step = read('tests/e2e/tls-mtls/lib/gzip-step.js');
    assert.match(step, /SUCCESS_MARKER = 'Gzip test passed'/);
    assert.match(step, /EADDRINUSE/);
  });

  it('memory tests measure peak RSS and native buffers', () => {
    const utils = read('tests/e2e/tls-mtls/memory-utils.js');
    assert.match(utils, /arrayBuffers/);
    assert.match(utils, /peakRss/);
    for (const file of ['tests/e2e/tls-mtls/test-backpressure.js', 'tests/e2e/tls-mtls/test-oversized-frame.js']) {
      const src = read(file);
      assert.match(src, /memory-utils/);
      assert.match(src, /startPeakSampler/);
      assert.match(src, /peakArrayBuffers/);
    }
  });
});

// Firewall mutation ORDERING tests (mocked/disposable).
//
// Regression: the deploy set `ufw default deny incoming` BEFORE adding the
// management allowances and BEFORE verifying them. On a host whose running
// firewall relied on the default-allow policy, a failure between those steps
// (or simply the reordering itself) could end the SSH session.
//
// `apply_firewall_rules()` now reads the existing rules, aborts on any
// deny/reject rule before mutating, adds allowances first, verifies them, and
// only then applies the restrictive default. These tests capture every mocked
// `ufw` invocation and assert the ordering (and the absence of mutations on
// failure paths). No real firewall or other device is involved.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createSandbox, cleanupSandbox, writeMock, sourceScript } = require('./helpers');

const MOCK_UFW = `
state="\${MOCK_UFW_DIR:?}"
rules="$state/rules.txt"
touch "$rules"
printf '%s\\n' "$*" >> "$state/calls.log"
case "$1" in
  show) cat "$rules" ;;
  status)
      if [ "\${MOCK_UFW_ACTIVE:-0}" = "1" ]; then echo "Status: active"; else echo "Status: inactive"; fi
      echo "Default: \${MOCK_UFW_DEFAULT_INCOMING:-deny} (incoming), allow (outgoing), disabled (routed)"
      ;;
  allow)
      if [ "\${MOCK_UFW_REGISTER_ALLOWS:-1}" = "1" ]; then printf 'ufw allow %s\\n' "$2" >> "$rules"; fi
      ;;
  default) : ;;
  --force) : ;;
esac
exit 0
`;

function runFirewall(sandbox, options = {}) {
  const {
    mgmt = '2222',
    active = false,
    defaultIncoming = 'deny',
    registerAllows = true,
    initialRules = ''
  } = options;

  writeMock(sandbox.bin, 'ufw', MOCK_UFW);
  const state = join(sandbox.root, 'ufw-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'calls.log'), '');
  writeFileSync(join(state, 'rules.txt'), initialRules);

  const res = sourceScript('scripts/deploy/setup-server-remote.sh', [], `
AS_ROOT=""
if ! reason="$(apply_firewall_rules "$TEST_MGMT")"; then
    printf 'FIREWALL_FAIL:%s\\n' "$reason"
else
    printf 'FIREWALL_OK\\n'
fi
`, {
    OKPROXY_AS_ROOT: '',
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    MOCK_UFW_DIR: state,
    MOCK_UFW_ACTIVE: active ? '1' : '0',
    MOCK_UFW_DEFAULT_INCOMING: defaultIncoming,
    MOCK_UFW_REGISTER_ALLOWS: registerAllows ? '1' : '0',
    TEST_MGMT: mgmt
  });

  const calls = readFileSync(join(state, 'calls.log'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return { res, calls, state };
}

const mutating = (calls) => calls.filter(c => !c.startsWith('show') && !c.startsWith('status'));

describe('firewall default/allow ordering', () => {
  it('adds and verifies management allowances before the restrictive default', () => {
    const sandbox = createSandbox('okproxy-fw-order-');
    try {
      const { res, calls } = runFirewall(sandbox, { mgmt: '2222' });
      assert.match(res.stdout, /FIREWALL_OK/, `${res.stdout}${res.stderr}`);

      const allowIdx = calls.indexOf('allow 2222/tcp');
      const denyIdx = calls.indexOf('default deny incoming');
      const enableIdx = calls.indexOf('--force enable');

      assert.ok(allowIdx >= 0, 'management allowance must be added');
      assert.ok(denyIdx > allowIdx, 'restrictive default must come after the management allowance');
      assert.ok(enableIdx > denyIdx, 'enable must come last');
      assert.strictEqual(calls.filter(c => c === 'default deny incoming').length, 1);
      assert.strictEqual(calls.filter(c => c === '--force enable').length, 1);
      // The rules are read at least twice: before mutating and before defaults.
      assert.ok(calls.filter(c => c.startsWith('show')).length >= 2, 'rules must be re-read for verification');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('keeps an already-active default-allow firewall reachable (allow before default)', () => {
    const sandbox = createSandbox('okproxy-fw-active-');
    try {
      const { res, calls } = runFirewall(sandbox, {
        mgmt: '2222',
        active: true,
        defaultIncoming: 'allow'
      });
      assert.match(res.stdout, /FIREWALL_OK/, `${res.stdout}${res.stderr}`);
      assert.ok(
        calls.indexOf('default deny incoming') > calls.indexOf('allow 2222/tcp'),
        'a running default-allow firewall must only become restrictive after the allowance exists'
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('makes no mutation at all when the existing rules contain a deny/reject rule', () => {
    const sandbox = createSandbox('okproxy-fw-denyabort-');
    try {
      const { res, calls } = runFirewall(sandbox, {
        mgmt: '2222',
        active: true,
        defaultIncoming: 'allow',
        initialRules: 'ufw allow 22/tcp\nufw deny 2222\n'
      });
      assert.match(res.stdout, /FIREWALL_FAIL:.*deny\/reject entries/);
      assert.deepStrictEqual(mutating(calls), [], 'no allow/default/enable may run before the abort');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('never applies a restrictive default when allowance verification fails', () => {
    const sandbox = createSandbox('okproxy-fw-verifyfail-');
    try {
      const { res, calls } = runFirewall(sandbox, {
        mgmt: '2222',
        active: true,
        defaultIncoming: 'allow',
        registerAllows: false
      });
      assert.match(res.stdout, /FIREWALL_FAIL:/);
      assert.ok(
        calls.some(c => c === 'allow 2222/tcp'),
        'the allowance attempt happens first (additive, harmless)'
      );
      assert.ok(
        !calls.some(c => c.startsWith('default')),
        'no default policy may be applied when verification fails'
      );
      assert.ok(
        !calls.includes('--force enable'),
        'the firewall must not be enabled when verification fails'
      );
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

// Firewall safety regression tests (mocked/disposable).
//
// Regression: the deploy used to fall back to port 22 when the SSH port could
// not be detected, and accepted any UFW line mentioning the port (including
// deny rules and unrelated ports). Both would risk locking the operator out or
// leaving SSH closed. Unknown detection and unverifiable/shadowed rules must
// now fail closed.
//
// ss/sshd are mocks in the sandbox PATH; nothing on the host is inspected or
// modified.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { createSandbox, cleanupSandbox, writeMock, sourceScript } = require('./helpers');

const SERVER_SCRIPT = 'scripts/deploy/setup-server-remote.sh';

function detectPorts(sandbox, { sshPort = '', ssOutput = [], sshdOutput = [] } = {}) {
  writeMock(sandbox.bin, 'ss', 'printf "%s\\n" "$MOCK_SS_OUTPUT"');
  writeMock(sandbox.bin, 'sshd', 'printf "%s\\n" "$MOCK_SSHD_OUTPUT"');
  return sourceScript(SERVER_SCRIPT, [], `
SSH_PORT="$TEST_SSH_PORT"
printf 'PORTS:%s\\n' "$(detect_management_ports)"
`, {
    OKPROXY_AS_ROOT: '',
    TEST_SSH_PORT: sshPort,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    MOCK_SS_OUTPUT: ssOutput.join('\n'),
    MOCK_SSHD_OUTPUT: sshdOutput.join('\n')
  });
}

function precheck(sandbox, ports, rules) {
  return sourceScript(SERVER_SCRIPT, [], `
if ! reason="$(firewall_precheck "$TEST_PORTS" "$TEST_RULES")"; then
    printf 'PRECHECK_FAIL:%s\\n' "$reason"
else
    printf 'PRECHECK_OK\\n'
fi
`, {
    OKPROXY_AS_ROOT: '',
    TEST_PORTS: ports,
    TEST_RULES: rules
  });
}

const LISTENER_2222 = ['LISTEN 0      128          0.0.0.0:2222       0.0.0.0:*'];
const LISTENER_22 = ['LISTEN 0      128          0.0.0.0:22         0.0.0.0:*'];

describe('management port detection', () => {
  it('prefers an explicitly configured SSH_PORT', () => {
    const sandbox = createSandbox('okproxy-fw-port-');
    try {
      const res = detectPorts(sandbox, { sshPort: '2222', ssOutput: LISTENER_22 });
      assert.strictEqual(res.status, 0, res.stderr);
      assert.match(res.stdout, /PORTS:2222/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('intersects live listeners with the sshd configuration', () => {
    const sandbox = createSandbox('okproxy-fw-intersect-');
    try {
      const res = detectPorts(sandbox, {
        ssOutput: [...LISTENER_22, ...LISTENER_2222],
        sshdOutput: ['port 2222']
      });
      assert.strictEqual(res.status, 0, res.stderr);
      assert.match(res.stdout, /PORTS:\s?2222/);
      assert.doesNotMatch(res.stdout, /PORTS:[\s\S]*\b22\b(?!2)/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('trusts the sshd configuration when the daemon is not listening yet', () => {
    const sandbox = createSandbox('okproxy-fw-sshd-only-');
    try {
      const res = detectPorts(sandbox, { ssOutput: [], sshdOutput: ['port 2222'] });
      assert.match(res.stdout, /PORTS:\s?2222/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('reports nothing (no port 22 fallback) when detection is unknown', () => {
    const sandbox = createSandbox('okproxy-fw-unknown-');
    try {
      const res = detectPorts(sandbox, { ssOutput: [], sshdOutput: [] });
      assert.strictEqual(res.status, 0, res.stderr);
      assert.match(res.stdout, /^PORTS:\s*$/m);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('does not guess 22 from an unverifiable listener alone', () => {
    const sandbox = createSandbox('okproxy-fw-guess-');
    try {
      const res = detectPorts(sandbox, { ssOutput: LISTENER_22, sshdOutput: [] });
      assert.match(res.stdout, /^PORTS:\s*$/m);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

describe('firewall precheck (fail closed)', () => {
  it('accepts an allow rule for the verified management port', () => {
    const sandbox = createSandbox('okproxy-fw-ok-');
    try {
      const res = precheck(sandbox, '2222', "ufw allow 2222/tcp\nufw allow 80/tcp");
      assert.match(res.stdout, /PRECHECK_OK/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('does not accept an unrelated port that merely contains the digits', () => {
    const sandbox = createSandbox('okproxy-fw-unrelated-');
    try {
      const res = precheck(sandbox, '22', "ufw allow 2200/tcp\nufw allow 222/tcp");
      assert.match(res.stdout, /PRECHECK_FAIL:management port 22 is not allowed/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed on any deny/reject rule, whatever its form', () => {
    const sandbox = createSandbox('okproxy-fw-deny-');
    const allow = 'ufw allow 2222/tcp';
    const cases = [
      ['bare port', `ufw deny 2222\n${allow}`],
      ['port range covering the management port', `ufw deny 2200:2300/tcp\n${allow}`],
      ['address-scoped deny', `ufw deny from 192.0.2.10\n${allow}`],
      ['reject rule', `ufw reject 2222/tcp\n${allow}`],
      ['deny for an unrelated port', `ufw deny 9999/udp\n${allow}`],
      ['status-style DENY line', `2222/tcp DENY Anywhere\n${allow}`]
    ];
    try {
      for (const [label, rules] of cases) {
        const res = precheck(sandbox, '2222', rules);
        assert.match(
          res.stdout,
          /PRECHECK_FAIL:.*deny\/reject rule\(s\) whose effect cannot be proven safe/,
          `expected fail-closed for: ${label}`
        );
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('does not interpret port ranges as an allow for the management port', () => {
    const sandbox = createSandbox('okproxy-fw-range-');
    try {
      const res = precheck(sandbox, '2222', 'ufw allow 2200:2300/tcp');
      assert.match(res.stdout, /PRECHECK_FAIL:management port 2222 is not allowed by an exact UFW rule/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('accepts a bare-port allow rule and ignores the status Default: line', () => {
    const sandbox = createSandbox('okproxy-fw-bare-');
    try {
      const bare = precheck(sandbox, '2222', 'ufw allow 2222');
      assert.match(bare.stdout, /PRECHECK_OK/);

      const statusStyle = precheck(
        sandbox,
        '2222',
        'Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n2222/tcp ALLOW Anywhere'
      );
      assert.match(statusStyle.stdout, /PRECHECK_OK/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails closed when the rule set cannot be read', () => {
    const sandbox = createSandbox('okproxy-fw-empty-');
    try {
      const res = precheck(sandbox, '22', '');
      assert.match(res.stdout, /PRECHECK_FAIL:could not read the UFW rule set/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('requires every management port to be allowed', () => {
    const sandbox = createSandbox('okproxy-fw-multi-');
    try {
      const ok = precheck(sandbox, '22 2222', "ufw allow 22/tcp\nufw allow 2222/tcp");
      assert.match(ok.stdout, /PRECHECK_OK/);

      const missing = precheck(sandbox, '22 2222', "ufw allow 22/tcp");
      assert.match(missing.stdout, /PRECHECK_FAIL:management port 2222 is not allowed/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('parses the verbose "port N proto tcp" rule form', () => {
    const sandbox = createSandbox('okproxy-fw-verbose-');
    try {
      const res = precheck(sandbox, '2222', 'ufw allow from 10.0.0.0/8 to any port 2222 proto tcp');
      assert.match(res.stdout, /PRECHECK_OK/);
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

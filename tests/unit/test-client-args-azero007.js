// CLI regression tests for the bracket-aware host:port parser
// (workspace okproxy-azero/007). Uniquely named to avoid collisions.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseArgs, parseHostPort } = require('../../apps/client/index.js');

function withExitTrap(fn) {
  const calls = [];
  const original = process.exit;
  process.exit = (code) => {
    calls.push(code);
    throw new Error('__exit__');
  };
  try {
    fn();
  } catch (err) {
    if (err.message !== '__exit__') throw err;
  } finally {
    process.exit = original;
  }
  return calls;
}

describe('parseHostPort', () => {
  it('parses hostname and IPv4 endpoints', () => {
    assert.deepStrictEqual(parseHostPort('localhost:9443'), { host: 'localhost', port: 9443 });
    assert.deepStrictEqual(parseHostPort('192.168.0.15:8080'), { host: '192.168.0.15', port: 8080 });
    assert.deepStrictEqual(parseHostPort('t0.arunoda.me:443'), { host: 't0.arunoda.me', port: 443 });
    assert.deepStrictEqual(parseHostPort('  localhost:80  ', '--server'), { host: 'localhost', port: 80 });
  });

  it('parses bracketed IPv6 endpoints (the macOS regression)', () => {
    assert.deepStrictEqual(parseHostPort('[::1]:9443'), { host: '::1', port: 9443 });
    assert.deepStrictEqual(parseHostPort('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 });
  });

  it('rejects bracketed addresses with zone IDs or IPv6-invalid characters', () => {
    assert.ok(parseHostPort('[fe80::1%lo0]:8080').error, 'zone id rejected (unsupported by tls.connect host)');
    assert.ok(parseHostPort('[zz::1]:80').error, 'invalid IPv6 characters');
  });

  it('rejects unbracketed IPv6 instead of misparsing the port', () => {
    const result = parseHostPort('::1:9443', '--server');
    assert.ok(result.error, 'unbracketed IPv6 is rejected');
    assert.match(result.error, /IPv6/);
    assert.ok(parseHostPort('2001:db8::1').error);
  });

  it('rejects missing/empty hosts and ports with strict validation', () => {
    assert.ok(parseHostPort('localhost').error, 'missing port');
    assert.ok(parseHostPort(':8080').error, 'missing host');
    assert.ok(parseHostPort('localhost:').error, 'empty port');
    assert.ok(parseHostPort('localhost:0').error, 'port 0');
    assert.ok(parseHostPort('localhost:65536').error, 'port out of range');
    assert.ok(parseHostPort('localhost:99a').error, 'non-numeric port');
    assert.ok(parseHostPort('localhost:-1').error, 'negative port');
    assert.ok(parseHostPort('localhost:1.5').error, 'float port');
    assert.ok(parseHostPort('ho st:80').error, 'whitespace in host');
    assert.ok(parseHostPort('[::1]').error, 'missing port after bracket');
    assert.ok(parseHostPort('[::1]9443').error, 'missing colon after bracket');
    assert.ok(parseHostPort('[zz::1]:80').error, 'invalid IPv6 characters');
    assert.ok(parseHostPort('[::1:80').error, 'unterminated bracket');
    assert.ok(parseHostPort('').error, 'empty value');
    assert.ok(parseHostPort(undefined).error, 'non-string value');
  });
});

describe('client parseArgs --server/--target', () => {
  it('defaults to localhost', () => {
    const opts = parseArgs([]);
    assert.strictEqual(opts.serverHost, 'localhost');
    assert.strictEqual(opts.serverPort, 9443);
    assert.strictEqual(opts.targetHost, 'localhost');
    assert.strictEqual(opts.targetPort, 3000);
  });

  it('accepts bracketed IPv6 for --server and --target', () => {
    const opts = parseArgs(['--server', '[::1]:9443', '--target', '[fe80::1]:3000']);
    assert.strictEqual(opts.serverHost, '::1');
    assert.strictEqual(opts.serverPort, 9443);
    assert.strictEqual(opts.targetHost, 'fe80::1');
    assert.strictEqual(opts.targetPort, 3000);
  });

  it('accepts hostname/IPv4 endpoints', () => {
    const opts = parseArgs(['--server', 't0.arunoda.me:443', '--target', '127.0.0.1:8080']);
    assert.strictEqual(opts.serverHost, 't0.arunoda.me');
    assert.strictEqual(opts.serverPort, 443);
    assert.strictEqual(opts.targetHost, '127.0.0.1');
    assert.strictEqual(opts.targetPort, 8080);
  });

  it('exits with code 1 on unbracketed IPv6', () => {
    const calls = withExitTrap(() => parseArgs(['--server', '::1:9443']));
    assert.deepStrictEqual(calls, [1]);
  });

  it('exits with code 1 on invalid ports and missing ports', () => {
    assert.deepStrictEqual(withExitTrap(() => parseArgs(['--server', 'localhost:0'])), [1]);
    assert.deepStrictEqual(withExitTrap(() => parseArgs(['--server', 'localhost:70000'])), [1]);
    assert.deepStrictEqual(withExitTrap(() => parseArgs(['--server', 'justhost'])), [1]);
    assert.deepStrictEqual(withExitTrap(() => parseArgs(['--target', '[::1]'])), [1]);
    assert.deepStrictEqual(withExitTrap(() => parseArgs(['--target', 'host:abc'])), [1]);
  });

  it('keeps other options working alongside bracketed endpoints', () => {
    const opts = parseArgs([
      '--server', '[2001:db8::1]:9443',
      '--target', 'localhost:3000',
      '--parallel-sockets', '2',
      '--preserve-host',
      '--domain', 'example.com'
    ]);
    assert.strictEqual(opts.serverHost, '2001:db8::1');
    assert.strictEqual(opts.serverPort, 9443);
    assert.strictEqual(opts.targetPort, 3000);
    assert.strictEqual(opts.parallelSockets, 2);
    assert.strictEqual(opts.preserveHost, true);
    assert.deepStrictEqual(opts.domains, ['example.com']);
  });
});

// Unit tests for the standalone gzip suite step (tests/e2e/tls-mtls/lib/gzip-step.js).
// No real ports are bound: the port probe and the child process are injected.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runGzipSuite, findBusyPorts, SUCCESS_MARKER } = require('../e2e/tls-mtls/lib/gzip-step');

const alwaysFree = async () => true;
const alwaysBusy = async () => false;
const execOk = () => ({ status: 0, stdout: `✓ ${SUCCESS_MARKER}`, stderr: '' });

describe('gzip suite runner step', () => {
  it('passes when the suite exits 0 and reports its success marker', async () => {
    const outcome = await runGzipSuite({ scriptPath: 'test-gzip.js', probe: alwaysFree, exec: execOk });
    assert.strictEqual(outcome.status, 'passed');
  });

  it('fails (no silent skip) when a fixed port is busy', async () => {
    const outcome = await runGzipSuite({ scriptPath: 'test-gzip.js', probe: alwaysBusy, exec: execOk });
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.reason, /19443/);
    assert.match(outcome.reason, /18080/);
    assert.match(outcome.reason, /OKPROXY_ALLOW_GZIP_SKIP/);
  });

  it('skips only with the explicit opt-in', async () => {
    const outcome = await runGzipSuite({
      scriptPath: 'test-gzip.js', probe: alwaysBusy, allowSkip: true, exec: execOk
    });
    assert.strictEqual(outcome.status, 'skipped');
  });

  it('fails on a bind error even when the process exits 0', async () => {
    const outcome = await runGzipSuite({
      scriptPath: 'test-gzip.js',
      probe: alwaysFree,
      exec: () => ({
        status: 0,
        stdout: '',
        stderr: 'Error: listen EADDRINUSE: address already in use :::19443'
      })
    });
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.reason, /EADDRINUSE/);
  });

  it('fails on a non-zero exit code', async () => {
    const outcome = await runGzipSuite({
      scriptPath: 'test-gzip.js', probe: alwaysFree, exec: () => ({ status: 1, stdout: '', stderr: 'boom' })
    });
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.reason, /status 1/);
  });

  it('fails when the success marker is missing (coverage skip)', async () => {
    const outcome = await runGzipSuite({
      scriptPath: 'test-gzip.js',
      probe: alwaysFree,
      exec: () => ({ status: 0, stdout: 'nothing ran here', stderr: '' })
    });
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.reason, /did not report/);
  });

  it('fails when the script path is missing', async () => {
    const outcome = await runGzipSuite({ probe: alwaysFree, exec: execOk });
    assert.strictEqual(outcome.status, 'failed');
  });

  it('reports every busy port', async () => {
    const busy = await findBusyPorts([1, 2, 3], async (port) => port !== 2);
    assert.deepStrictEqual(busy, [2]);
  });
});

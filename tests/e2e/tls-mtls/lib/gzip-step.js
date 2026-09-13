'use strict';

// Standalone gzip e2e suite step, shared by run.js and run-all.js.
//
// The gzip suite is a plain script (not node:test) that binds the fixed ports
// 19443 and 18080. Coverage must not silently disappear: a busy port, a bind
// error inside the suite, a non-zero exit or a missing success marker are all
// FAILURES. Skipping is only possible with an explicit opt-in
// (OKPROXY_ALLOW_GZIP_SKIP=1).

const { spawnSync } = require('node:child_process');
const net = require('node:net');

const DEFAULT_PORTS = [19443, 18080];
const SUCCESS_MARKER = 'Gzip test passed';

/** Resolve true when a TCP listener can be bound on 127.0.0.1:<port>. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findBusyPorts(ports, probe = isPortFree) {
  const busy = [];
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    const free = await probe(port);
    if (!free) busy.push(port);
  }
  return busy;
}

/**
 * Run the standalone gzip suite.
 * @returns {Promise<{status: 'passed'|'failed'|'skipped', reason?: string}>}
 */
async function runGzipSuite(options = {}) {
  const {
    scriptPath,
    ports = DEFAULT_PORTS,
    allowSkip = false,
    probe = isPortFree,
    exec = (path) => spawnSync(process.execPath, [path], { stdio: 'pipe', encoding: 'utf8' })
  } = options;

  if (!scriptPath) {
    return { status: 'failed', reason: 'gzip suite path is missing' };
  }

  const busy = await findBusyPorts(ports, probe);
  if (busy.length > 0) {
    const detail = `TCP port(s) ${busy.join(', ')} are in use (the gzip suite binds the fixed ports ${ports.join(', ')})`;
    if (!allowSkip) {
      return {
        status: 'failed',
        reason: `prerequisite not met: ${detail}. Free them, or re-run with OKPROXY_ALLOW_GZIP_SKIP=1 to skip this suite explicitly.`
      };
    }
    return { status: 'skipped', reason: `explicitly skipped (OKPROXY_ALLOW_GZIP_SKIP=1): ${detail}` };
  }

  const res = exec(scriptPath) || {};
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';

  if (`${stderr}\n${stdout}`.includes('EADDRINUSE')) {
    return {
      status: 'failed',
      reason: `gzip suite could not bind its ports: ${`${stderr}\n${stdout}`
        .split('\n')
        .filter((line) => line.includes('EADDRINUSE'))
        .join(' | ')}`
    };
  }
  if (res.status !== 0) {
    return { status: 'failed', reason: `gzip suite exited with status ${res.status}` };
  }
  if (!stdout.includes(SUCCESS_MARKER)) {
    return {
      status: 'failed',
      reason: `gzip suite did not report "${SUCCESS_MARKER}" (skipped or incomplete coverage)`
    };
  }
  return { status: 'passed' };
}

module.exports = { runGzipSuite, findBusyPorts, isPortFree, DEFAULT_PORTS, SUCCESS_MARKER };

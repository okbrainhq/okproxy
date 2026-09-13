#!/usr/bin/env node
// TLS E2E Test Runner (full suite including long timeout tests)
//
// Included suites:
//   - all node:test regressions in the TLS e2e and unit directories
//     (including CLI, HTTP/metadata and transport tests)
//   - standalone gzip suite: tests/e2e/tls-mtls/test-gzip.js (not node:test;
//     spawned as a child process)
//
// Prerequisites:
//   - Node.js >= 20 (node:test runner + --test style reporting)
//   - openssl available on PATH (e2e setup generates a throwaway CA/certs)
//   - The full suite takes several minutes: test-sse-timeout.js alone holds
//     connections open for ~2 minutes.
//   - The gzip suite binds fixed TCP ports 19443 and 18080, so those ports must
//     be free. A busy port, bind error, non-zero exit or missing success marker is
//     a FAILURE (no silent coverage loss); set OKPROXY_ALLOW_GZIP_SKIP=1 to skip
//     the suite explicitly.
//   - tests/unit/test-parse-args.js only requires repo files; no network.

const { run } = require('node:test');
const { join } = require('node:path');

const { readdirSync } = require('node:fs');
const testFiles = [
  // Keep mandatory deployment runner suites explicit; discover other unit and
  // transport regressions without duplicating them. Gzip runs standalone once.
  '../../unit/test-parse-args.js',
  '../../unit/test-gzip-step.js',
  ...readdirSync(join(__dirname, '../../unit'))
    .filter(f => /^test-.*\.js$/.test(f) && !['test-parse-args.js', 'test-gzip-step.js'].includes(f))
    .sort().map(f => '../../unit/' + f),
  ...readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f) && f !== 'test-gzip.js').sort()
];

// Files that need longer timeout (in ms)
const longTimeoutFiles = new Set([
  'test-sse-timeout.js', // 65s test + 60s slow headers test + margin = ~130s
  'test-bugfixes.js'
]);

// Timeout values for different test types (in ms)
const TIMEOUTS = {
  default: 30000,
  long: 180000 // 3 minutes for SSE timeout tests (65s + 60s tests + margin)
};

// Standalone (non-node:test) suites with their fixed port prerequisites.
// Coverage must not silently vanish: busy ports / bind errors / non-zero exits
// are failures unless OKPROXY_ALLOW_GZIP_SKIP=1 is set explicitly.
const { runGzipSuite } = require('./lib/gzip-step');

const STANDALONE_SUITES = [
  { name: 'test-gzip.js', file: 'test-gzip.js', ports: [19443, 18080], allowSkipEnv: 'OKPROXY_ALLOW_GZIP_SKIP' }
];

async function runStandaloneSuite(suite, results) {
  process.stdout.write(`${suite.name} ... `);
  const outcome = await runGzipSuite({
    scriptPath: join(__dirname, suite.file),
    ports: suite.ports,
    allowSkip: process.env[suite.allowSkipEnv] === '1'
  });

  if (outcome.status === 'passed') {
    console.log('✓');
    results.passed++;
  } else if (outcome.status === 'skipped') {
    console.log(`- (${outcome.reason})`);
    results.skipped++;
  } else {
    console.log('✗');
    console.error(`  ${outcome.reason}`);
    results.failed++;
  }
}

async function main() {
  console.log('Running Tunzero E2E tests (all including timeout tests)...\n');

  const results = {
    passed: 0,
    failed: 0,
    skipped: 0
  };

  for (const file of testFiles) {
    const filePath = join(__dirname, file);
    process.stdout.write(`${file} ... `);

    try {
      // Use longer timeout for tests that need it (e.g., SSE timeout tests run for 65+ seconds)
      const timeout = longTimeoutFiles.has(file) ? TIMEOUTS.long : TIMEOUTS.default;
      const stream = run({
        files: [filePath],
        timeout
      });

      let passed = 0;
      let failed = 0;

      for await (const event of stream) {
        if (event.type === 'test:pass' && event.data.details?.type !== 'suite') {
          passed++;
        } else if (event.type === 'test:fail') {
          failed++;
          console.error(`\n  FAIL: ${event.data.name}`);
          if (event.data.details?.error) {
            console.error(`    ${event.data.details.error.message}`);
          }
        }
      }

      results.passed += passed;
      results.failed += failed;

      if (failed === 0) {
        console.log(`✓ (${passed} passed)`);
      } else {
        console.log(`✗ (${passed} passed, ${failed} failed)`);
      }
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      results.failed++;
    }
  }

  for (const suite of STANDALONE_SUITES) {
    await runStandaloneSuite(suite, results);
  }

  console.log('\n-------------------');
  console.log(`Total: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

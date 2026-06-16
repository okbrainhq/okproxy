#!/usr/bin/env node
// TLS E2E Test Runner (All tests including timeout tests)

const { run } = require('node:test');
const { join } = require('node:path');

const testFiles = [
  'test-frames.js',
  'test-init.js',
  'test-connection.js',
  'test-http-get.js',
  'test-http-post.js',
  'test-concurrent.js',
  'test-streaming.js',
  'test-sse.js',
  'test-sse-timeout.js', // Tests SSE connections stay open beyond 30s timeout
  'test-large-body.js',
  'test-disconnect.js',
  'test-reconnect.js',
  'test-malformed.js',
  'test-oversized-frame.js',
  'test-ping-pong.js',
  'test-backpressure.js',
  'test-max-streams.js',
  'test-stream-timeout.js',
  'test-cors.js',
  'test-security.js',
  'test-revocation.js',
  'test-websocket.js',
  'test-websocket-bugs.js',
  'test-bugfixes.js',
  'test-multipath.js',
  'test-multipath-e2e.js',
  'test-multi-client-domains.js'
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
        if (event.type === 'test:pass') {
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

  console.log('\n-------------------');
  console.log(`Total: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

#!/usr/bin/env node
// TLS E2E Test Runner

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
  'test-security.js'
];

async function main() {
  console.log('Running TLS E2E tests...\n');

  const results = {
    passed: 0,
    failed: 0,
    skipped: 0
  };

  for (const file of testFiles) {
    const filePath = join(__dirname, file);
    process.stdout.write(`${file} ... `);

    try {
      const stream = run({
        files: [filePath],
        timeout: 30000
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

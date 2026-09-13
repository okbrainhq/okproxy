#!/usr/bin/env node
// Mocked deployment validation runner.
//
// Runs the deployment tests in tests/deploy/. Everything is disposable: deploy
// scripts execute inside temp sandboxes with mock ssh/scp/sudo/systemctl/
// launchctl/ss/sshd/ufw, so no host service, unit file, firewall rule or remote
// host is touched.
//
// Network safety net: this runner prepends a guard directory to PATH containing
// ssh/scp/rsync/sftp stubs that refuse to run. Tests that need ssh/scp put their
// own sandbox mocks first (they shadow the guard); anything that forgets to mock
// them is blocked instead of connecting to another device.
//
// Prerequisites:
//   - Node.js >= 20
//   - git on PATH (fixture repositories are created and cloned locally)
//   - openssl on PATH (trust-coherence fixtures)
//   - no network access required or used

const { run } = require('node:test');
const { join } = require('node:path');
const { readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const testFiles = readdirSync(__dirname)
  .filter(name => name.startsWith('test-') && name.endsWith('.js'))
  .sort();

const TIMEOUT = 120000;

/** Block accidental ssh/scp/rsync/sftp usage unless a sandbox mock shadows it. */
function installNetworkGuard() {
  const guardDir = mkdtempSync(join(tmpdir(), 'okproxy-nonet-'));
  const blocked = ['ssh', 'scp', 'rsync', 'sftp', 'ssh-copy-id', 'nc', 'telnet'];
  for (const tool of blocked) {
    const file = join(guardDir, tool);
    writeFileSync(
      file,
      `#!/bin/bash\necho "BLOCKED: ${tool} is disabled inside the mocked deployment tests (no connections to other devices)." >&2\nexit 111\n`
    );
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${guardDir}:${process.env.PATH}`;
  process.env.OKPROXY_DEPLOY_NETWORK_GUARD = guardDir;
  return guardDir;
}

async function main() {
  console.log('Running mocked deployment validation tests...\n');
  const guardDir = installNetworkGuard();
  console.log(`Network guard active (ssh/scp/rsync blocked): ${guardDir}\n`);

  const results = { passed: 0, failed: 0, skipped: 0 };

  for (const file of testFiles) {
    process.stdout.write(`${file} ... `);
    try {
      const stream = run({
        files: [join(__dirname, file)],
        timeout: TIMEOUT
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

  rmSync(guardDir, { recursive: true, force: true });
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

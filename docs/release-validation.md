# Release Validation — 2026-09-13

- Revision: `86eb9715c9d436c2b6809c377e3a6e04944a630b` (main, "Merge okbrain/okproxy-azero/023-b1a635e0 into main")
- Workspace: `okbrain/okproxy-azero/024-287284b0` (isolated worktree), aZero host only. No SSH/scp/rsync to other devices; no live service changes.

## Commands and runner-reported results

| Command | Runner-reported result |
| --- | --- |
| `npm run test:all` (`tests/e2e/tls-mtls/run-all.js`) | 243 passed, 0 failed, 0 skipped |
| `npm run test:deploy` (`tests/deploy/run.js`) | 141 passed, 0 failed, 0 skipped |
| `node --test tests/unit/*.js` (focused unit) | 63 passed, 0 failed (8 suites) |
| `python3 macos-client/tests/critical-invariants.py` | 25 checks passed |

`test:all` ran the 5 unit files plus 34 e2e files and the standalone non-node:test
gzip suite (fixed ports 19443/18080 were free; no silent skip).

`test:deploy` per-suite counts: test-client-ubuntu-install 6, test-escape-helpers 7,
test-firewall-ordering 5, test-firewall 15, test-flag-parsing 11, test-macos-plist 3,
test-orchestrator-quoting 4, test-script-regressions 17, test-server-install 20,
test-server-trust-release 16, test-server-trust 22, test-server-unit 9,
test-server-upload 6 — total 141.

Helper checks cover the production C helper compiled with `-Wall -Wextra -Werror`,
immediate posix_spawn cancellation, descendant cleanup, process-group SIGKILL
recovery, atomic installer replacement and offline full-installer paths.

## Test safety (inspected before running)

`tests/deploy/run.js` prepends a guard directory to `PATH` whose stubs reject
`ssh`, `scp`, `rsync`, `sftp`, `ssh-copy-id`, `nc`, `telnet`; suites that need them
put sandbox mocks first. Deploy scripts execute in temp sandboxes against mock
ssh/scp/sudo/systemctl/launchctl/ss/sshd/ufw. No remote host, unit file, firewall
rule or running service is touched. No network access required.

## Known issue (reported, not fixed)

`npm run test:deploy:unit` (`node --test tests/deploy/`) exits 1: the Node 22 test
runner treats the directory argument as an entry module (MODULE_NOT_FOUND), giving
1 test / 1 fail. Noncritical — the supported `npm run test:deploy` command passed
all 141 deployment checks; the convenience `test:deploy:unit` command remains
broken. Left unchanged; this validation adds one documentation file only.

## Known limits (not validated here)

- Transport protocol v2 requires a coordinated rollout; incompatible with legacy lanes.
- Lane loss cancels the session; no replay of in-flight requests.
- macOS Swift build/execution not performed on this Linux host (checks are structural only).
- CRL storage errors are not fail-closed.
- Deployment SIGKILL/power loss requires manual recovery.
- Concurrent deployments are unsupported.
- No production rollout performed.

## Change control

Only file added: `docs/release-validation.md`. No commit made.

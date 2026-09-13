# Deployment fixes (audited)

Scope: `scripts/deploy/**`, test runner config (`package.json`,
`tests/e2e/tls-mtls/run*.js`, `tests/e2e/tls-mtls/lib/gzip-step.js`), new
mocked deployment tests (`tests/deploy/**`) and memory-measurement helpers
(`tests/e2e/tls-mtls/memory-utils.js`).

**No production host was touched.** Nothing was deployed, no live service was
restarted, no host config was changed, and **no SSH/SCP/rsync connection to any
other device is made by these scripts or tests**: every deployment test runs the
real scripts against mock `ssh`/`scp`/`sudo`/`systemctl`/`loginctl`/`launchctl`/
`ss`/`sshd`/`ufw` binaries inside a throwaway temp sandbox (`tests/deploy/helpers.js`).
Only loopback TCP is used by the existing e2e suite.

## 1. First server install deleted uploaded trust material and regenerated the CA

**Problem.** `setup-server-remote.sh` replaced `/opt/okproxy` before looking for
certificates, while the orchestrator uploaded certs into `/opt/okproxy/certs`
and `/opt/okproxy/ca`. The first production install therefore deleted the
uploaded server key/cert and CA, then generated a brand new CA — invalidating
every client certificate issued from the real CA.

**Fix.**
- Trust material now lives outside the replaceable checkout under
  `/var/lib/okproxy` (server key/cert in `certs/`, CA cert + `ca-key.pem` when
  server-generated + index files in `ca/`). Since section 10 below those
  directories are reached through the `current` release symlink
  (`/var/lib/okproxy/current/{certs,ca}`).
- `setup-server.sh --upload-certs` uploads there and only chowns
  `/var/lib/okproxy` (never `/opt`).
- The checkout is only auto-removed when it is not a git repo **and** contains
  nothing but previously known deployment artifacts; otherwise the deploy aborts
  with "Refusing to delete it".
- `ensure_server_trust_set()` replaces the old "generate if missing" branch and
  **never regenerates an existing CA**. If the server pair is missing or
  incomplete it is re-issued from the existing CA (requires `ca-key.pem`);
  a complete-but-mismatched pair fails closed with an explicit message.
- `tunnel-ca.js init` (which creates a new CA) runs **only when the trust state is
  genuinely empty** — `trust_dirs_empty()` checks `ls -A` on both directories, so
  hidden files count. A CA key-only state, a records-only state (index / CRL /
  serial counter / issued-domains), a missing `ca-cert.pem`, an orphan leaf key or
  anything else partial **aborts and preserves the files** with a listing instead
  of initialising over recoverable material.

## 2. Migration reversed the historically active cert precedence and mixed sets

**Problem (first round).** Migration iterated `.certs` before `certs` (reversing
the historical precedence) and selected cert and CA independently, so it could
copy a certificate from one layout and the CA from another.

**Fix.** `migrate_legacy_trust_material()` now:
- treats a server pair and its sibling CA directory as **one coherent set**
  (`certs`+`ca` first, then `.certs`+`.ca`, matching the historical active
  choice), and validates it cryptographically (`cert_signed_by_ca`,
  `key_matches_cert`) before copying anything;
- copies only (never moves/deletes), and never touches a complete coherent set
  already present in `/var/lib/okproxy`;
- fails closed on a partial layout (pair without its CA), on a cert that does not
  chain to its sibling CA, and when the persistent CA differs from the legacy CA
  ("two different CAs are present");
- refuses to copy into a destination directory that already holds partial or
  unrecognised material (for example a `ca-key.pem` without its certificate, or an
  orphan leaf key) — that material is preserved and the deploy aborts;
- carries over a legacy CA (with its key) when no legacy server pair exists, so
  a CA that issued client certificates is never silently regenerated.

Cryptographic checks use `openssl verify` and public-key comparison, so a
half-copied or hand-edited pair is rejected instead of installed.

## 3. `--cert-bound-domains false` silently became cert-bound

**Problem.** The orchestrator passed `--cert-bound-domains` and `false` as two
tokens; the remote parser matched the bare flag (→ `true`) and the stray `false`
shifted into the positional arguments, silently turning a classic deployment
into a cert-bound one.

**Fix.**
- The remote parser accepts `--cert-bound-domains`, `--cert-bound-domains true|false`
  and `--cert-bound-domains=true|false`, and **fails closed** on any other value.
- `CERT_BOUND_DOMAINS` is validated once after parsing (both scripts).
- The orchestrator forwards a single escaped token
  `--cert-bound-domains=<value>`.

## 4. Ubuntu redeploy accepted a historical log and skipped rollback under `set -e`

**Problem.** A redeploy used `enable --now` (which does not restart a running
unit) and grep'ed the (append-only) log for "Connected to TLS tunnel server", so
a previous successful run satisfied the health check. Additionally a failing
`systemctl restart` aborted the script under `set -e` **before** rollback, and
rollback only restored the unit file — not the code revision that the same run
had just `git reset --hard`-ed.

**Fix.**
- Explicit `restart` (never `enable --now`), with the exit status captured in
  `RESTART_OK` so a failure cannot bypass rollback.
- Readiness requires: unit active, **new** `InvocationID` (different from the
  pre-restart one) **and** new log bytes appended after a recorded byte offset.
  A historical "Connected..." line can no longer pass.
- `rollback_release()` runs for both an immediate restart failure and a readiness
  timeout, and restores the previous **code revision** (`git reset --hard
  $PREV_CODE_REV`) *and* the previous unit file, then restarts it. A fresh
  install with no previous unit is stopped **and disabled** to avoid a boot loop.
- `OKPROXY_READINESS_ATTEMPTS` overrides the poll budget so tests can exercise
  the timeout path quickly.

## 5. `/opt` was recursively chowned

**Problem.** The orchestrator ran `chown -R "$USER" "$(dirname "$APP_DIR")"`,
i.e. a recursive chown of `/opt`.

**Fix.** Only the application directory is created/owned; the clone goes into
that pre-created directory. No parent directory is ever chowned recursively.

## 6. systemd writable paths were not always created

**Problem.** The unit listed `ReadWritePaths=/opt/okproxy/ca
/opt/okproxy/certs /opt/okproxy/.ca /opt/okproxy/.certs` under
`ProtectSystem=strict`. The hidden paths do not exist in the uploaded layout, and
a missing `ReadWritePaths` entry can make systemd fail to start the unit.

**Fix.** `render_okproxy_unit()` is generated from `readwrite_paths()`: the
required directories (`/var/lib/okproxy/certs`, `/var/lib/okproxy/ca`) are
created before install and listed unconditionally; legacy hidden paths are listed
with the `-` (ignore-if-missing) prefix. Unit rendering is a pure function and is
unit-tested.

## 7. Firewall allowed only port 22 and accepted unrelated/deny rules

**Problem.** When the SSH port could not be detected the deploy fell back to
`22`; rules were validated with a substring grep that accepted `ufw deny 22/tcp`
and unrelated ports such as `2200/tcp` (the digits matched).

**Fix.** Fail closed, verified against the real listener:
- `detect_management_ports()` prefers an explicit `--ssh-port`/`SSH_PORT`, then
  intersects live `ss -tlnH` listeners with `sshd -T`, then trusts the sshd
  configuration if the daemon is not listening yet. If the port cannot be
  determined it prints nothing and the deploy **aborts without enabling UFW**
  (no port-22 assumption).
- `firewall_precheck()` is deliberately conservative: **any** `deny`/`reject`
  rule (bare port, `N/tcp`, port range `N:M`, address-scoped, any port) makes the
  deploy refuse to enable UFW and print the offending lines plus manual-handling
  instructions — no attempt is made to prove such rules safe by parsing. With no
  deny/reject rules present, every management port must still be covered by an
  **exact** allow rule (bare `<port>`, `<port>/tcp`, or verbose
  `... port <port> proto tcp`); ranges and other forms are not interpreted and
  the message tells the operator to add `sudo ufw allow <port>/tcp`. An
  unreadable rule set also fails closed. The status header
  (`Default: deny (incoming), ...`) is not treated as a rule.
- **Mutation ordering** lives in `apply_firewall_rules()`: (1) read the existing
  rules, (2) abort on any deny/reject rule **before** changing anything, (3) add
  the management/HTTP/TLS allowances (purely additive, so an already-active
  firewall is never restricted by this step), (4) verify the management
  allowances exist, (5) only then apply `default deny incoming` /
  `default allow outgoing`, (6) re-verify, (7) `ufw --force enable`. A failure
  before step 5 leaves the previous default policy untouched, so a running
  default-allow firewall cannot be locked out by a partially-applied deploy.
  Captured-invocation tests assert the ordering and that failure paths perform
  no `default`/`enable` mutation at all.

## 8. gzip suite could silently disappear from the runners

**Problem.** The runners skipped the standalone gzip suite whenever ports
19443/18080 were busy, so coverage could vanish unnoticed; a suite that exited 0
without running its checks was also counted as passing.

**Fix.** `tests/e2e/tls-mtls/lib/gzip-step.js` is used by both runners:
- busy ports, `EADDRINUSE`, a non-zero exit, or a missing `Gzip test passed`
  marker are **failures**;
- skipping requires the explicit opt-in `OKPROXY_ALLOW_GZIP_SKIP=1`;
- the CLI unit suites (`tests/unit/test-parse-args.js`,
  `tests/unit/test-gzip-step.js`) are part of both runners.

## 9. Memory measurements only looked at `heapUsed`

**Problem.** `test-backpressure.js` and `test-oversized-frame.js` asserted on a
single `heapUsed` delta. Frames are relayed through Buffers, so native buffer
growth (and RSS) is the meaningful signal.

**Fix.** `tests/e2e/tls-mtls/memory-utils.js` provides an interval peak sampler
(`rss`, `arrayBuffers`, `external`, `heapUsed`) which both tests now use, with
thresholds on peak RSS and native buffer growth. No application file was
modified.

## 10. Interrupted certificate upload could pair a NEW certificate with the OLD key

**Problem.** `setup-server.sh --upload-certs` scp'd `server-cert.pem` and then
`server-key.pem` straight into the *active* `/var/lib/okproxy/certs`. An upload
interrupted between the two files replaced only one of them, and nothing
validated the result before the next `systemctl restart okproxy` picked it up.

**Fix (staged upload -> validated release -> atomic activation).**
- The active trust set is a *release directory* referenced through one symlink:
  `/var/lib/okproxy/current -> releases/<release-id>`, with `current/certs` and
  `current/ca` as the active paths.
- The uploader writes every file into `/var/lib/okproxy/staging/<release-id>/`
  (`certs/`, `ca/`), which is never an active path. The active directories are
  not written to at all.
- `--trust-release-validate=<id>` runs on the server **before** anything is
  activated: it requires `certs/server-cert.pem`, `certs/server-key.pem` and
  `ca/ca-cert.pem`, verifies `key_matches_cert()` and `cert_signed_by_ca()`,
  applies permissions, writes the `READY` marker last and promotes the staging
  directory to the persistent `releases/<id>` directory. A missing, truncated or
  incoherent file aborts with "The active trust material was not modified."
- Setup receives `--deploy-trust-release=<id>`, captures old state, prepares and
  checks service-user readability, then calls the atomic activation primitive.
  The low-level `--trust-release-activate=<id>` recovery action requires a promoted, coherent, `READY`-marked
  release and flips the symlink with a **single** `mv -T` rename, so the active
  set changes from one complete release to another complete release with no
  window in which a new certificate can sit next to an old key. If the activated
  set does not validate, the previous release is restored automatically.
- Failed uploads are discarded (`--trust-release-discard=<id>`); validated
  releases are rollback history and are never deleted.
- `bootstrap_trust_release_layout()` migrates a pre-existing real `certs/`+`ca/`
  layout into the first release (checked copy plus full directory comparison),
  points `current` at it and leaves originals at their existing absolute paths. A pre-existing
  non-empty real `current` directory is refused, not removed.
- The unit keeps referencing `current/certs/...`, so a later activation or
  rollback does not require rewriting the unit.
- Uploads no longer activate, so there is no stale pre-upload pointer handoff.
  Setup captures the old pointer before any mutation and captures a newly
  bootstrapped legacy pointer before activation. It never guesses the old release
  from the new active pointer or an overwritten `previous-release` file.

## 11. Server deploy replaced code/unit and restarted without rollback

**Problem.** The production path reset the git checkout, overwrote
`/etc/systemd/system/okproxy.service` and ran `systemctl restart okproxy` without
checking the result, then "verified" health with a check that could be satisfied
by output from a previous run.

**Fix.** The setup transaction begins before bootstrap/checkout changes and stays
armed until the final local readiness check. It:
- captures the previous code revision **before** the checkout is updated
  (`capture_previous_checkout_revision()`), the previous invocation id, the
  active trust pointer and a copy of the installed unit
  (`<unit>.okproxy-backup.<unique-suffix>`). Git safe ownership is configured
  before revision capture; an existing service with an unknown revision aborts
  before updates. There is no fallback to the newly fetched HEAD;
- installs the rendered unit with an explicit failure check and restarts with
  `if ! sudo systemctl restart okproxy` so `set -e` cannot skip the rollback;
- verifies health against the **current invocation**: `systemctl is-active`,
  a *changed* `InvocationID` and `ss -ltnpH` showing both 8080 and 9443 owned
  by that service's MainPID, with an invocation recheck. `/health` does not exist:
  a healthy router with no client returns 404 in cert-bound mode or 502 in
  classic mode. This is local server readiness, not target, TLS-handshake,
  Caddy or end-to-end health. No application endpoint/security surface was added;
- on errors (including permissions, unit install, daemon-reload, explicit exit),
  catchable INT/TERM/HUP interruptions, restart failure or readiness timeout calls
  `rollback_server_release()`, which restores the previous code revision, the
  previous unit and the previous trust pointer, and stops/disables the unit when
  there was nothing to restore.

## 12. Automatic SSH hardening could lock out the only administrator

**Problem.** The production path rewrote `sshd_config` (`PasswordAuthentication
no`, `PermitRootLogin no`) and then restarted `ssh` unconditionally, on the same
session that was running the deploy. On a host where administrators only use
passwords (or only log in as root) this is a permanent lockout, and the restart
itself can drop the deploying session.

**Fix.** The deployment no longer touches `sshd_config`, never runs `sshd -t`
and never restarts/reloads `ssh`; it prints a manual opt-in recipe instead.

**SSH hardening (manual opt-in).** From a second, already-verified session:
1. confirm key access first —
   `ssh -o PreferredAuthentications=publickey <user>@<host> true`;
2. back up and edit the config —
   `sudo cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.bak`, then set
   `PasswordAuthentication no` / `PermitRootLogin no`;
3. validate and reload — `sudo sshd -t && sudo systemctl reload ssh` (reload, not
   a blind restart) and keep the first session open until access is confirmed;
4. roll back with
   `sudo cp -p /etc/ssh/sshd_config.bak /etc/ssh/sshd_config`.

The deployment performs no live access verification of its own.

## 13. macOS installer assumed ~/Library/LaunchAgents already existed

**Problem.** `setup-client-remote.sh` unloaded the previous LaunchAgent and
removed its plist, then wrote the new plist into `~/Library/LaunchAgents/`
without creating the directory. On a fresh macOS home directory the write fails
(`No such file or directory`) and the client is left with no agent at all. The
old test hid the bug by pre-creating the directory.

**Fix.** The installer creates `$HOME/Library/LaunchAgents` (`PLIST_DIR`) together
with the cert/log directories before the plist is written, and the mocked test
covers a fresh `HOME` without `~/Library`.

## Rollout and rollback requirements

Trust material now moves through *staged -> validated release -> activated
release*. When rolling this out:

1. Deploy with the normal order (`setup-server.sh [--upload-certs]`): uploads are
   staged and validated only. Setup captures the old state before changes,
   ensures service permissions, then activates inside its rollback transaction.
   Do not use the low-level activation action for deployment: it has no encompassing
   service transaction or permission setup.
2. An upgraded host keeps its previous trust set: the first run adopts the old
   `certs/`+`ca/` directories into `releases/bootstrap-<timestamp>/` and keeps the
   originals in place for old absolute-path units. Manual trust-pointer recovery
   is a single symlink swap (also restore the matching code/unit and restart):
   `sudo ln -sfn releases/<old-id> /var/lib/okproxy/current.new &&
   sudo mv -T /var/lib/okproxy/current.new /var/lib/okproxy/current`
   (equivalently `trust_restore_pointer releases/<old-id>`).
3. Never delete directories under `/var/lib/okproxy/releases`: they are the
   rollback history. Failed stagings live in `/var/lib/okproxy/staging/` and may
   be removed with `--trust-release-discard=<id>`.
4. If a rollback fired, inspect any restoration warnings and confirm the old
   code/unit/trust before retrying; inspect the "Last log lines" of the failing run
   (`journalctl -u okproxy -n 50`) before retrying.
5. SSH hardening is a deliberate operator step (section 12) and is **not** part of
   the deployment.
6. Roll out in this order when operating a mixed fleet: update the *uploader*
   (`setup-server.sh`) and the remote script together (the uploader calls
   `--trust-release-*` actions that only the new remote script implements), and
   keep the previous release directory on disk so a code rollback can also be
   paired with a trust rollback.

## How to validate

```bash
bash -n scripts/deploy/*.sh      # syntax
npm run test:deploy              # mocked deployment suite (no host changes, no ssh)
npm run test:unit                # CLI + gzip-step unit tests
npm test                         # core e2e + unit + gzip (needs free 19443/18080)
npm run test:all                 # full e2e incl. SSE timeout (~4 min)
```

`tests/deploy/**` covers, with mocks: escaping helpers (including the `$`
specifier/`pidsub_replacement` pitfalls), rendered server unit + static safety,
hostile-config orchestrator quoting (captured remote command executed against
stubs with canaries), the real Ubuntu installer against a mock `systemctl`
(success, restart failure, readiness timeout, rollback of code + unit), trust
migration precedence/coherence and CA preservation, boolean flag parsing and
forwarding, firewall fail-closed detection/precheck, macOS plist XML escaping and
a fresh-`HOME` `~/Library/LaunchAgents` install, staged trust upload/inspection
(interrupted scp, rejected validation, refused activation), the server trust
release layout (staging -> validation -> atomic activation -> rollback pointer,
legacy layout adoption) and the server unit deployment against mocked
`systemctl`/`ss`/`journalctl` (restart/readiness/daemon-reload failure, permission
errors, explicit exit and TERM interruption, old absolute unit paths plus trust,
failed/incomplete copies with errexit disabled, dubious-ownership capture), plus
real loopback router 404/502 regression probes and runner/gzip-skip regressions.

`npm run test:deploy` additionally installs a **network guard**: `ssh`, `scp`,
`rsync`, `sftp`, `ssh-copy-id`, `nc` and `telnet` stubs that exit 111 are
prepended to `PATH`, so any test that forgets to mock one of them is blocked
instead of connecting to another device.

## Limitations

- **No real remote deployment was performed** (out of scope). Mocked validation
  covers argument serialization and script control flow, not a live distro.
- `APP_DIR=/opt/okproxy` and `DATA_DIR=/var/lib/okproxy` remain the defaults
  (no flag to relocate them). `OKPROXY_DATA_DIR` / `OKPROXY_TRUST_ROOT`
  / `OKPROXY_SERVER_UNIT_PATH` / `OKPROXY_READINESS_ATTEMPTS` exist so the mocked
  tests can point the trust layout, unit path and readiness budget at a sandbox;
  they are not a supported production override.
- The release symlink is the single point of activation: a hard kill between
  the `READY` promotion and the `mv -T` swap leaves the previous release active
  (safe), and a hard kill during `mv -T` itself is a single rename, so the active
  pointer is either the old or the new complete release, never a mixture.
- Migration only understands cert/CA layouts (`certs`, `ca`, `.certs`, `.ca`).
  Any other unexpected file inside the checkout aborts the deploy by design.
- Two complete legacy layouts with different material: the historically active
  one (`certs`+`ca`) wins and a warning is printed; genuinely ambiguous cases
  (partial layout, foreign CA next to a persistent pair) abort.
- `openssl` must be available on the server for the trust-coherence checks
  (already required by the CA tooling).
- Firewall: if `sshd -T`/`ss` cannot be read and no `SSH_PORT` is configured, the
  deploy stops before enabling UFW. The operator must set `SSH_PORT` manually.
- `gzip` coverage is only skippable on explicit request; `npm test` therefore
  requires ports 19443/18080 to be free.
- Active transport behaviour (frames, multipath, WebSocket proxying) is another
  worker's scope; only memory *measurement* was improved here.
- Peak sampling is interval-based (default 20-25 ms), so very short spikes
  between samples can be missed; thresholds are deliberately generous.

### Transaction limits

Catchable failures restore the captured code revision, unit and trust pointer;
rollback errors are reported rather than claimed successful. SIGKILL/power loss
cannot run shell traps: retain unit backups, old revisions and release directories
for manual recovery. OS packages, Caddy configuration, firewall policy and unrelated
service settings are not reverted by the code/unit/trust transaction. Serialize
deployments; concurrent deploys and external trust edits are not supported. Existing
services with no capturable checkout revision fail closed for manual migration.
No actual SSH, systemd operations or live deployment are used in validation: sandbox
helpers default-deny unmocked privilege/service/transport commands.

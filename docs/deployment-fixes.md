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
- Trust material now lives outside the replaceable checkout:
  `/var/lib/okproxy/certs` (server key/cert) and `/var/lib/okproxy/ca`
  (CA cert, `ca-key.pem` when server-generated, index files).
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
forwarding, firewall fail-closed detection/precheck, macOS plist XML escaping,
and runner/gzip-skip regressions.

`npm run test:deploy` additionally installs a **network guard**: `ssh`, `scp`,
`rsync`, `sftp`, `ssh-copy-id`, `nc` and `telnet` stubs that exit 111 are
prepended to `PATH`, so any test that forgets to mock one of them is blocked
instead of connecting to another device.

## Limitations

- **No real remote deployment was performed** (out of scope). Mocked validation
  covers argument serialization and script control flow, not a live distro.
- `APP_DIR=/opt/okproxy` and `DATA_DIR=/var/lib/okproxy` remain hardcoded (no
  flag to relocate them).
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

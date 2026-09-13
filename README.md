# okproxy

A secure ngrok alternative using TLS encryption with mutual TLS (mTLS) authentication. **Zero third-party dependencies** — only Node.js built-in modules.

## Features

- **TLS 1.2+ encryption** with mutual TLS (mTLS)
- **Multipath** — duplicates traffic across WiFi, iPhone USB, and other interfaces concurrently. Fastest path wins; automatic failover
- **Multiplexing** — multiple concurrent HTTP requests over a set of TLS tunnel connections
- **Parallel tunnel sockets** — optional extra tunnel sockets plus single-flow upload/media routing keep normal traffic responsive
- **WebSocket support** — full duplex WebSocket proxying
- **Streaming** — SSE, large file transfers, and long-lived connections
- **Auto-reconnection** — per-connection exponential backoff (500ms → 3s max)
- **Keepalive** — per-connection PING/PONG with configurable intervals; relaxed pacing in multipath mode
- **Backpressure** — flow control when network or target is slow
- **Certificate revocation** — server checks CRL on each connection
- **Caddy SSL** — automatic HTTPS with Let's Encrypt (server deploy)
- **Network watchdog** — detects interface changes and reconnects on the new network

## Quick Start — Local mTLS

This creates one local CA, one server certificate, and two client certificates bound to two public app domains.

### 1. Create CA + Server + Two Clients

```bash
# One-time CA. Keep .ca/ca-key.pem private and do not upload it to servers.
npx ca init

# Server certificate for local development.
npx ca issue-server --hostname localhost --output ./.certs

# Client 1: authorized for p0.example.test
npx ca issue-client \
  --name p0 \
  --domain p0.example.test \
  --output ./.certs/p0

# Client 2: authorized for p1.example.test
npx ca issue-client \
  --name p1 \
  --domain p1.example.test \
  --output ./.certs/p1

# Optional: verify issued certs/domains
npx ca list
cat .ca/issued-domains.json
```

### 2. Run a Local Target App

Run any HTTP service locally. For a quick test:

```bash
python3 -m http.server 3000
```

### 3. Run the Server Locally

Single-client/basic mode:

```bash
node apps/server/index.js \
  --http-port 8080 \
  --tls-port 9443 \
  --key ./.certs/server-key.pem \
  --cert ./.certs/server-cert.pem \
  --ca ./.ca/ca-cert.pem \
  --ca-dir ./.ca
```

Cert-bound multi-client mode, matching production behavior:

```bash
node apps/server/index.js \
  --http-port 8080 \
  --tls-port 9443 \
  --key ./.certs/server-key.pem \
  --cert ./.certs/server-cert.pem \
  --ca ./.ca/ca-cert.pem \
  --ca-dir ./.ca \
  --cert-bound-domains \
  --issued-domain-index ./.ca/issued-domains.json
```

### 4. Run a Client Locally

Client `p0` forwarding to the target on `localhost:3000`:

```bash
node apps/client/index.js \
  --server localhost:9443 \
  --target localhost:3000 \
  --key ./.certs/p0/client-key.pem \
  --cert ./.certs/p0/client-cert.pem \
  --ca ./.ca/ca-cert.pem
```

Run client `p1` the same way with its cert directory:

```bash
node apps/client/index.js \
  --server localhost:9443 \
  --target localhost:3000 \
  --key ./.certs/p1/client-key.pem \
  --cert ./.certs/p1/client-cert.pem \
  --ca ./.ca/ca-cert.pem
```

Optional multipath mode:

```bash
node apps/client/index.js \
  --server localhost:9443 \
  --target localhost:3000 \
  --key ./.certs/p0/client-key.pem \
  --cert ./.certs/p0/client-cert.pem \
  --ca ./.ca/ca-cert.pem \
  --multipath
```

### 5. Access the Local Tunnel

```bash
# Basic local access
curl http://localhost:8080/

# Cert-bound Host routing test
curl -H 'Host: p0.example.test' http://localhost:8080/
curl -H 'Host: p1.example.test' http://localhost:8080/

# Caddy ask endpoint should allow domains in .ca/issued-domains.json
curl -si 'http://localhost:8080/_okproxy/caddy-ask?domain=p0.example.test'
```

## Multipath

When `--multipath` is enabled, the client binds TLS connections to each internet-capable network interface (WiFi, iPhone USB, etc.). With `--parallel-sockets <n>`, each interface can open multiple tunnel sockets. Normal streams keep traditional multipath behavior: each frame is duplicated across all active tunnel sockets and the fastest copy wins.

Large upload/streaming requests opt out of multipath duplication and use a single flow. The server detects these by request features: common audio/video file extensions, `Accept: audio/*` / `video/*`, `Sec-Fetch-Dest: audio|video`, `Range` requests, multipart/form-data uploads, raw binary uploads, and resumable upload headers. This keeps audio/file traffic on one tunnel socket while unrelated requests can still use other sockets. Multipath keeps a relaxed keepalive rhythm (15s PING / 45s timeout), while single-interface mode uses aggressive keepalive (3s PING / 10s timeout) for fast failure detection.

```bash
# Enable on the client
npm run client -- --multipath

# Add parallel lanes per interface for large audio/file transfers
npm run client -- --multipath --parallel-sockets 4

# The deploy scripts enable multipath and default to PARALLEL_SOCKETS=4
```

With multipath, you'll see per-interface logs:

```
[en0] 2026-05-01T09:32:04.849Z sending PING
[en8] 2026-05-01T09:32:04.059Z sending PING
[en0] 2026-05-01T09:32:04.931Z received PONG
[en8] 2026-05-01T09:32:04.158Z received PONG
```

## Local Key Management

```bash
npx ca init                                           # Initialize CA (one-time)
npx ca issue-server --hostname <d> --output ./.certs # Server certificate
npx ca issue-client --name <n> --domain <domain> \
  --output ./.certs/<n>                              # Client certificate
npx ca issue-client --domain <domain> \
  --allow-domain-overlap                             # Rotation/re-issue only
npx ca list                                           # List issued certificates
npx ca revoke --serial <n>                            # Revoke a certificate
```

Client domains are stored in `.ca/issued-domains.json`. In cert-bound mode, Caddy uses the server ask endpoint to allow HTTPS only for issued/connected client domains. When a valid client connects, the server also ensures the domains from that client certificate are present in the issued-domain index.

### Certificate Validity

| Certificate | Validity | Usage |
|-------------|----------|-------|
| CA | 10 years | Sign client/server certs |
| Server | 1 year | TLS server authentication |
| Client | 1 year | TLS client authentication |

### Directory Layout

```
.ca/                       # CA files (keep secure)
.certs/                    # Server & client certificates
```

## Server Deployment (Debian/Ubuntu)

The server deploy script copies `setup-server-remote.sh` to your VM, installs Node.js + Caddy, configures `okproxy.service` as `User=okproxy`, opens ports `80`, `443`, `9443` and the configured SSH management port, and hardens the box with Fail2Ban/UFW.

### 1. Prepare Production CA + Certs Locally

Create the CA and issue one server cert plus one cert per client/domain:

```bash
# One-time CA. Keep .ca/ca-key.pem private on your secure machine.
npx ca init

# TLS tunnel server certificate. Use your tunnel host here.
npx ca issue-server \
  --hostname d0.example.com \
  --output ./.certs

# Client/domain 1
npx ca issue-client \
  --name p0 \
  --domain p0.example.com \
  --output ./.certs/p0

# Client/domain 2
npx ca issue-client \
  --name p1 \
  --domain p1.example.com \
  --output ./.certs/p1
```

The server deploy uploads only the server TLS files and public CA metadata it needs:

```text
.certs/server-key.pem
.certs/server-cert.pem
.ca/ca-cert.pem
.ca/issued-domains.json
.ca/crl.txt, if present
```

It does **not** upload `.ca/ca-key.pem`.

On the server the trust material is stored **outside the git checkout**, as a
release directory referenced through one symlink: `/var/lib/okproxy/current` →
`/var/lib/okproxy/releases/<release-id>`, i.e. the active paths are
`/var/lib/okproxy/current/certs` (server key/cert) and
`/var/lib/okproxy/current/ca` (CA cert, `issued-domains.json`, `crl.txt`), so a
clone/update can never delete it.

`--upload-certs` never writes into the active directories. Every file is first
staged in `/var/lib/okproxy/staging/<release-id>/`, validated **on the server**
(key must match the certificate, certificate must chain to the CA) and promoted
to `/var/lib/okproxy/releases/<release-id>`. The uploader only stages/validates;
setup captures old code/unit/trust, makes the release readable by `okproxy`, and
then replaces the one `current` symlink atomically within its rollback transaction. An upload interrupted halfway
therefore cannot leave a new certificate next to an old key, and the previously
active release stays on disk as rollback history (a failed startup restores it
automatically). Failed stagings are removed with
`setup-server-remote.sh --trust-release-discard=<release-id>`; validated releases
are never deleted.

If a host still has the legacy in-checkout layout (`/opt/okproxy/certs`,
`/opt/okproxy/ca`, `/opt/okproxy/.certs`, `/opt/okproxy/.ca`), the next deploy
copies the **coherent set that the running service used** (the historically
active `certs`+`ca` first) into the persistent release directory after
cryptographic validation; partial or mismatched layouts abort instead of
guessing, and partial material already there is never overwritten. A
pre-existing real `/var/lib/okproxy/certs`+`ca` layout is adopted into the first
release (original directories stay unchanged at their absolute paths, so old
units remain usable on rollback). An existing CA is never regenerated — if the server pair is
missing or incomplete it is re-issued from the existing CA (which requires
`ca-key.pem` on the host). A new CA is only created when both trust directories
are genuinely empty (hidden files included); any partial state (CA key only,
records only, missing `ca-cert.pem`, orphan leaf key, …) aborts and preserves the
files.

Readiness requires a fresh systemd invocation plus HTTP/TLS listeners owned by
its MainPID, not a connected client/target. There is no `/health` endpoint: routing
can legitimately return 404 (cert-bound) or 502 (classic) with no client. Failures
and catchable interruptions restore code/unit/trust; SIGKILL, power loss and
unrelated OS/package/Caddy/firewall changes require operator recovery (see runbook).

The deployment never edits `/etc/ssh/sshd_config` and never restarts `ssh`:
automatic `PasswordAuthentication no` / `PermitRootLogin no` hardening could lock
out every administrator on a password-only or root-only host. Harden SSH
manually from a second, already-verified session instead
(`ssh -o PreferredAuthentications=publickey …`, `sudo sshd -t`,
`sudo systemctl reload ssh`) — see `docs/deployment-fixes.md`.

The UFW rules open the SSH management port configured in `.deploy.server`
(`SSH_PORT`) or verified from the live listener + `sshd` configuration. UFW is
only enabled when the port could be verified, no `deny`/`reject` rule exists at
all, and every management port has an exact `allow` rule. Mutations are ordered
safely: existing rules are read and validated first, allowances are added and
verified before any restrictive default is applied, and the firewall is enabled
last — so an already-active default-allow firewall is never locked out by a
partially-applied deploy. If the port cannot be determined, or any deny/reject
rule is present, the deploy stops before changing anything (with instructions)
instead of assuming port 22.

### 2. Configure `.deploy.server`

Create `.deploy.server` from `.deploy.server.example`:

```bash
# Public tunnel endpoint used by clients for mTLS
HOSTNAME=d0.example.com

# Repository to deploy on the server
REPO_URL=https://github.com/arunoda/okproxy.git

# Optional: Git branch to deploy (default: main)
BRANCH=main

# Optional: default deploy target so the command can omit USER@HOST
DEPLOY_HOST=deploy@d0.example.com

# Optional: custom SSH port (default: 22)
# SSH_PORT=2222

# Optional: cert-bound multi-client mode is enabled by default
# CERT_BOUND_DOMAINS=true
```

Point DNS for the tunnel host and each public app domain to the production server IP:

```text
d0.example.com  -> server IP, client mTLS endpoint on :9443
p0.example.com  -> server IP, HTTPS app via Caddy :443
p1.example.com  -> server IP, HTTPS app via Caddy :443
```

### 3. Deploy the Production Server

```bash
# First deploy: upload server certs + public CA metadata and install service
./scripts/deploy/setup-server.sh deploy@d0.example.com --upload-certs

# If DEPLOY_HOST is set in .deploy.server, the host can be omitted
./scripts/deploy/setup-server.sh --upload-certs

# Later updates: fetch configured BRANCH, restart okproxy, reload Caddy
./scripts/deploy/setup-server.sh

# Override branch for one deploy
./scripts/deploy/setup-server.sh --branch multi-client

# Legacy single-client mode, if needed
./scripts/deploy/setup-server.sh --classic
```

In cert-bound mode the service runs with the issued-domain index:

```bash
apps/server/index.js --http-port 8080 --tls-port 9443 \
  --key /var/lib/okproxy/current/certs/server-key.pem \
  --cert /var/lib/okproxy/current/certs/server-cert.pem \
  --ca /var/lib/okproxy/current/ca/ca-cert.pem \
  --ca-dir /var/lib/okproxy/current/ca \
  --cert-bound-domains \
  --http-host 127.0.0.1 \
  --issued-domain-index /var/lib/okproxy/current/ca/issued-domains.json
```

Caddy is configured for on-demand HTTPS and asks okproxy before issuing a cert:

```text
http://127.0.0.1:8080/_okproxy/caddy-ask
```

When a valid client connects, okproxy reads the domains from the client certificate SAN and ensures they exist in `issued-domains.json`, so Caddy can issue HTTPS for those domains.

Server ports: `80` HTTP redirect, `443` public HTTPS via Caddy, `9443` TLS tunnel.

## Client Deployment

`scripts/deploy/setup-client.sh` is platform aware. It detects the target OS (`uname -s`) and runs the matching remote installer:

| Target | Remote script | Service manager |
|--------|---------------|-----------------|
| macOS | `setup-client-remote.sh` | LaunchAgent `com.okproxy.client[.<name>]` |
| Linux (Debian/Ubuntu) | `setup-client-remote-ubuntu.sh` | systemd unit `okproxy-client[-<name>]` |

Both installers use Node.js (20+, installed to `~/.local` when the host has no suitable system Node.js), clone/update the repo to `~/okproxy`, verify the client certs, and start the client with `--multipath` plus `--parallel-sockets ${PARALLEL_SOCKETS:-4}`.

Pass `--local` to run the installer on the current machine instead of over SSH, and `--platform darwin|linux` to skip platform detection.

### macOS

Create `.deploy.client` from `.deploy.client.example`:

```bash
SERVER_HOST=tunnel.example.com:9443
TARGET_HOST=localhost:3000
REPO_URL=https://github.com/arunoda/okproxy.git

# Unique profile name for this client on the Mac
CLIENT_NAME=blog

# Local cert directory to upload for this client
CLIENT_CERT_DIR=./.certs/blog

# Optional: default SSH target
DEPLOY_HOST=user@192.168.0.15

# Optional: custom SSH port
# SSH_PORT=2222

# Optional: override remote cert path
# REMOTE_CERT_DIR=~/.okproxy/certs/blog
```

Prepare one certificate directory per client/domain:

```bash
npx ca issue-client \
  --name blog \
  --domain blog.example.com \
  --output ./.certs/blog
```

Deploy the client:

```bash
# First deploy for this client profile: upload selected cert directory
./scripts/deploy/setup-client.sh user@192.168.0.15 --upload-certs

# Or select certs explicitly from the command line
./scripts/deploy/setup-client.sh user@192.168.0.15 \
  --client-name blog \
  --cert-dir ./.certs/blog \
  --upload-certs

# Later updates without re-uploading certs
./scripts/deploy/setup-client.sh user@192.168.0.15 --client-name blog
```

`setup-client.sh` uploads these files from `CLIENT_CERT_DIR` to the remote cert directory:

```text
client-cert.pem
client-key.pem
ca-cert.pem
```

The remote cert directory defaults to:

```text
~/.okproxy/certs/<CLIENT_NAME>
```

For `CLIENT_NAME=default`, it keeps the old path:

```text
~/.okproxy/certs
```

The LaunchAgent label and logs are profile-specific:

```bash
# Manage on the Mac
launchctl list com.okproxy.client.blog
launchctl start com.okproxy.client.blog
launchctl stop com.okproxy.client.blog

# Logs
tail -f ~/.okproxy/logs/blog/client.log
tail -f ~/.okproxy/logs/blog/client-error.log
```

If you need a custom Node binary on the Mac:

```bash
OKPROXY_NODE_PATH=/path/to/node ./setup-client-remote.sh ...
```

### Ubuntu / Debian (systemd)

`setup-client.sh` detects Linux and uses `setup-client-remote-ubuntu.sh`, so the same `.deploy.client` works for both platforms. Use `--local` when the client host is the machine you are running from (no SSH/SCP needed):

```bash
# Deploy on this host, reusing certs already present in the cert dir
./scripts/deploy/setup-client.sh --local \
  --client-name blog \
  --cert-dir ~/.okproxy/certs/blog

# Deploy over SSH to an Ubuntu host (first run uploads the certs)
./scripts/deploy/setup-client.sh ubuntu@10.0.0.5 --upload-certs \
  --client-name blog \
  --cert-dir ./.certs/blog
```

The Linux installer can also be run directly on the host, which is what the deploy script does over SSH:

```bash
./scripts/deploy/setup-client-remote-ubuntu.sh <SERVER_HOST> <TARGET_HOST> <REPO_URL> [CLIENT_NAME] [CERT_DIR] [PARALLEL_SOCKETS] [options]
```

Options:

```text
--app-dir <path>       Repo/app directory on the host (default: $HOME/okproxy)
--branch <name>        Branch to deploy (default: main)
--node-path <path>     Use this Node.js binary instead of auto-detecting one
--service-user <user>  Run the system service as this user (default: current user)
--system               Force a system-wide unit in /etc/systemd/system (needs root/sudo)
--user                 Force a per-user unit in ~/.config/systemd/user
--no-multipath         Single-connection mode instead of multipath
--no-start             Install the unit without enabling/starting it
```

What the installer does:

1. Uses a system Node.js 20+ when present, otherwise installs the latest Node.js LTS into `~/.local` (SHA256-verified official tarball for `linux-x64`/`linux-arm64`).
2. Clones the repo into `$HOME/okproxy` (override with `--app-dir`), or hard-updates it to `origin/<branch>` when it already exists.
3. Verifies `client-cert.pem`, `client-key.pem` and `ca-cert.pem` in the cert directory (`~/.okproxy/certs/<CLIENT_NAME>`, or `~/.okproxy/certs` for `default`) and tightens key permissions to `600`.
4. Writes a systemd unit with `Restart=always`, `RestartSec=5`, `NoNewPrivileges`, `ProtectSystem=full`, and appends logs to `~/.okproxy/logs/<CLIENT_NAME>/client.log` and `client-error.log`. It installs a system-wide unit when root or passwordless `sudo` is available, otherwise a `systemctl --user` unit plus `loginctl enable-linger`.
5. Enables and starts the unit, then waits up to 30 s for `Connected to TLS tunnel server` in the client log.

Manage the service on the host:

```bash
systemctl status okproxy-client            # or okproxy-client-<name>
sudo systemctl restart okproxy-client-blog
sudo systemctl stop okproxy-client-blog
tail -f ~/.okproxy/logs/blog/client.log        # client output
tail -f ~/.okproxy/logs/blog/client-error.log  # client errors
sudo journalctl -u okproxy-client-blog -f      # service lifecycle (start/stop/restarts)
```

The unit label and log directory mirror the macOS LaunchAgent layout, so both platforms stay consistent. To use a specific Node.js binary, set `OKPROXY_NODE_PATH=/path/to/node` before running the installer or pass `--node-path`.

📖 Full runbook for the Linux service — unit definition, certificate lifecycle (restart-to-apply), health-check recipes, troubleshooting table, verification record and uninstall: [`.design/12-client-ubuntu-systemd-service.md`](.design/12-client-ubuntu-systemd-service.md).

## Server Options

```
--http-port <port>          HTTP server port (default: 8080)
--tls-port <port>           TLS tunnel port (default: 9443)
--key <path>                Server private key
--cert <path>               Server certificate
--ca <path>                 CA certificate
--ca-dir <path>             CA directory
--max-streams <n>           Max concurrent streams (default: 100)
--stream-timeout <ms>       Stream inactivity timeout (default: 300000, i.e. 5 minutes)
--keepalive-interval <ms>   PING interval (default: 10000)
--keepalive-timeout <ms>    PONG timeout (default: 25000)
--http-keepalive-timeout <ms> HTTP keep-alive timeout for Caddy/browser side (default: 3600000)
--http-headers-timeout <ms> HTTP headers timeout (default: 3605000)
--cert-bound-domains        Enable certificate-bound Host routing
--issued-domain-index <p>   Issued domain index path
--http-host <host>          HTTP bind host (use 127.0.0.1 behind Caddy)
```

## Client Options

```
--server <host:port>        Tunnel server (default: localhost:9443)
--target <host:port>        Local target service (default: localhost:3000)
--target-timeout <ms>       Target response/upgrade timeout; 0 disables (default: 30000)
--target-keepalive-timeout <ms> Target idle keep-alive timeout; 0 disables idle expiry (default: 3600000)
--parallel-sockets <n>      Parallel tunnel sockets per interface, 1-32 (default: 1; deploy default: 4)
--key <path>                Client private key
--cert <path>               Client certificate
--ca <path>                 CA certificate
--multipath                 Enable multipath over all available interfaces
--domain <domain>           Optional authorized domain subset (repeatable)
--preserve-host             Forward original public Host header to target
```

## Protocol

### Frame Format (13-byte header)

```
┌──────────────┬─────────┬──────────────┬──────────┬─────────────┐
│ Stream ID    │ Type    │ Seq Number   │ Length   │ Payload     │
│ 4 bytes BE   │ 1 byte  │ 4 bytes BE   │ 4 bytes  │ N bytes     │
└──────────────┴─────────┴──────────────┴──────────┴─────────────┘
```

### Frame Types

| Type | Value | Purpose |
|------|-------|---------|
| HEADERS | `0x01` | HTTP metadata (JSON) |
| DATA | `0x02` | Body chunk |
| FIN | `0x03` | Stream complete |
| ERROR | `0x04` | Stream error |
| INIT | `0x05` | Connection handshake |
| PING | `0x06` | Keepalive ping |
| PONG | `0x07` | Keepalive response |
| UPGRADE | `0x08` | WebSocket upgrade |
| RESET_SEQ | `0x09` | Sequence counter reset |

### INIT Handshake

Per-connection on connect:

```
Client → Server: { interface: "en0#1", maxFrameSize: 1048576 }
Server → Client: { maxFrameSize: 1048576, maxConcurrentStreams: 100 }
```

Each connection performs its own INIT independently. The `interface` field identifies the physical interface and optional lane suffix (for example, `en0#1`). Reconnecting with the same interface/lane replaces the old socket.

### Sequence Numbers

Every data frame carries a 32-bit, per-stream monotonic sequence number. Normal multipath streams are duplicated across tunnel sockets and the receiver uses a 128-bit sliding window to discard duplicates. Single-flow streams (media extensions, audio/video accepts, Range requests, multipart/raw uploads, or resumable upload headers) are pinned to one tunnel socket. `RESET_SEQ` prevents overflow on long-lived streams.

### Keepalive

| Mode | PING interval | PONG timeout |
|------|--------------|-------------|
| Single-connection | 3s | 10s |
| Multipath (per connection) | 15s | 45s |
| Server (per connection) | 10s | 25s |

## Directory Structure

```
apps/
  server/                   # Tunnel server
    index.js
    lib/
      tls-server.js         # TLS server with mTLS
      http-router.js        # HTTP → tunnel routing + WebSocket
      connection-pool.js    # Multi-connection manager with dedup
      ca.js                 # Certificate Authority
    bin/tunnel-ca.js        # CA management CLI
  client/                   # Tunnel client
    index.js
    lib/
      virtual-socket.js     # Multipath/parallel lane layer: stream affinity & dedup
      real-socket.js        # Single TLS connection per interface
      interface-detector.js # Connectivity-based interface discovery
      network-watchdog.js   # OS interface change detection
      proxy.js              # HTTP/WebSocket proxy to local target
packages/
  frame-protocol/           # Shared 13-byte framing protocol
    index.js                # Encoder/decoder + frame types
    dedup-window.js         # Sliding window deduplication
scripts/deploy/             # Server & client deployment scripts
tests/e2e/tls-mtls/         # E2E test suite
tests/unit/                 # CLI argument parsing unit tests
tests/deploy/               # Mocked/disposable deployment validation
docs/deployment-fixes.md    # Deployment audit fixes and limitations
```

## Tests

```bash
npm test                     # Core suite (includes CLI unit + gzip suites)
npm run test:all             # Full suite including SSE timeout tests
npm run test:unit            # CLI arg-parsing unit tests only
npm run test:gzip            # Standalone content-encoding suite only
npm run test:deploy          # Mocked deployment validation (no host changes)
node --test tests/e2e/tls-mtls/test-multipath.js   # just multipath
```

Notes and prerequisites:

- Node.js >= 20 and `openssl` on `PATH` (e2e setup generates a throwaway CA).
- The standalone gzip suite binds the fixed ports `19443` and `18080`. A busy
  port, bind error, non-zero exit or missing success marker is a **failure** (no
  silent coverage loss); set `OKPROXY_ALLOW_GZIP_SKIP=1` only if you intend to
  skip that suite.
- `npm run test:all` takes several minutes because `test-sse-timeout.js` holds
  connections open for ~2 minutes by design.
- `npm run test:deploy` runs the deploy scripts inside throwaway sandboxes with
  mock `ssh`/`scp`/`sudo`/`systemctl`/`launchctl`/`ss`/`sshd`/`ufw`. It never
  installs a service, changes a firewall, contacts a remote host or opens any
  SSH/SCP/rsync connection. It requires `git` and `openssl` on `PATH`.

## License

MIT

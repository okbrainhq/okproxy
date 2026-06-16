# okproxy

A secure ngrok alternative using TLS encryption with mutual TLS (mTLS) authentication. **Zero third-party dependencies** — only Node.js built-in modules.

## Features

- **TLS 1.2+ encryption** with mutual TLS (mTLS)
- **Multipath** — duplicates traffic across WiFi, iPhone USB, and other interfaces concurrently. Fastest path wins; automatic failover
- **Multiplexing** — multiple concurrent HTTP requests over a single set of TLS connections
- **WebSocket support** — full duplex WebSocket proxying
- **Streaming** — SSE, large file transfers, and long-lived connections
- **Auto-reconnection** — per-connection exponential backoff (500ms → 3s max)
- **Keepalive** — per-connection PING/PONG with configurable intervals; relaxed pacing in multipath mode
- **Backpressure** — flow control when network or target is slow
- **Certificate revocation** — server checks CRL on each connection
- **Caddy SSL** — automatic HTTPS with Let's Encrypt (server deploy)
- **Network watchdog** — detects interface changes and reconnects on the new network

## Quick Start — Local

### 1. Generate Keys

```bash
npx ca init
npx ca issue-server --hostname localhost --output ./.certs
npx ca issue-client
```

### 2. Start Server

```bash
npm run server
```

### 3. Start Client

```bash
# Single connection (any interface)
npm run client -- --target localhost:3000

# Multipath (all available interfaces)
npm run client -- --target localhost:3000 --multipath
```

### 4. Access

```bash
curl http://localhost:8080/your-endpoint
```

## Multipath

When `--multipath` is enabled, the client binds a TLS connection to each internet-capable network interface (WiFi, iPhone USB, etc.). Every frame is duplicated across all connections — whichever delivers first wins. Duplicates are discarded via per-stream sequence numbers.

Multipath keeps a relaxed keepalive rhythm (15s PING / 45s timeout) since redundancy handles individual link failures. Single-connection mode uses aggressive keepalive (3s PING / 10s timeout) for fast failure detection.

```bash
# Enable on the client
npm run client -- --multipath

# The deploy scripts enable it by default via MULTIPATH_ENABLED=true
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
npx ca init                          # Initialize CA (one-time)
npx ca issue-server --hostname <d>   # Server certificate
npx ca issue-client                  # Client certificate
npx ca list                          # List issued certificates
npx ca revoke --serial <n>           # Revoke a certificate
```

### Certificate Validity

| Certificate | Validity | Usage |
|-------------|----------|-------|
| CA | 10 years | Sign client/server certs |
| Server | 1 year | TLS server authentication |
| Client | 90 days | TLS client authentication |

### Directory Layout

```
.ca/                       # CA files (keep secure)
.certs/                    # Server & client certificates
```

## Server Deployment (Debian/Ubuntu)

The server deploy script copies `setup-server-remote.sh` to your VM, installs Node.js + Caddy, configures `okproxy.service`, opens ports `80`, `443`, and `9443`, and hardens the box with Fail2Ban/UFW.

Create `.deploy.server` from `.deploy.server.example`:

```bash
HOSTNAME=tunnel.example.com
REPO_URL=https://github.com/arunoda/okproxy.git

# Optional: default deploy target so the command can omit USER@HOST
DEPLOY_HOST=deploy@tunnel.example.com

# Optional: custom SSH port (default: 22)
# SSH_PORT=2222

# Optional: cert-bound multi-client mode is enabled by default
# CERT_BOUND_DOMAINS=true
```

Prepare server certs locally if you want to upload them:

```bash
npx ca init
npx ca issue-server --hostname tunnel.example.com --output ./.certs
```

Deploy:

```bash
# First deploy: uploads server certs + CA metadata, then installs service
./scripts/deploy/setup-server.sh user@server --upload-certs

# Later updates: git reset/restart on the VM
./scripts/deploy/setup-server.sh user@server

# Legacy single-client mode, if needed
./scripts/deploy/setup-server.sh user@server --classic
```

In cert-bound mode the service runs with:

```bash
apps/server/index.js --http-port 8080 --tls-port 9443 \
  --cert-bound-domains --http-host 127.0.0.1
```

Caddy is configured for on-demand HTTPS and uses the server ask endpoint:

```text
http://127.0.0.1:8080/_okproxy/caddy-ask
```

Point each public app domain to the server IP. The tunnel TLS endpoint remains `tunnel.example.com:9443`.

Server ports: `80` HTTP redirect, `443` public HTTPS via Caddy, `9443` TLS tunnel.

## Client Deployment (macOS)

The client deploy script copies `setup-client-remote.sh` to the Mac, installs/uses Node.js, clones the repo to `~/okproxy`, uploads the selected client certs, and creates a LaunchAgent with `--multipath` enabled.

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

## Server Options

```
--http-port <port>          HTTP server port (default: 8080)
--tls-port <port>           TLS tunnel port (default: 9443)
--key <path>                Server private key
--cert <path>               Server certificate
--ca <path>                 CA certificate
--ca-dir <path>             CA directory
--max-streams <n>           Max concurrent streams (default: 100)
--stream-timeout <ms>       Stream inactivity timeout (default: 30000)
--keepalive-interval <ms>   PING interval (default: 10000)
--keepalive-timeout <ms>    PONG timeout (default: 25000)
--cert-bound-domains        Enable certificate-bound Host routing
--issued-domain-index <p>   Issued domain index path
--http-host <host>          HTTP bind host (use 127.0.0.1 behind Caddy)
```

## Client Options

```
--server <host:port>        Tunnel server (default: localhost:9443)
--target <host:port>        Local target service (default: localhost:3000)
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
Client → Server: { interface: "en0", maxFrameSize: 1048576 }
Server → Client: { maxFrameSize: 1048576, maxConcurrentStreams: 100 }
```

Each connection performs its own INIT independently. The `interface` field tells the server which physical interface this connection represents, so reconnections from the same interface replace the old one.

### Sequence Numbers

Every data frame carries a 32-bit, per-stream monotonic sequence number. When multipath duplicates a frame across multiple connections, the receiver uses a 128-bit sliding window to discard duplicates — first arrival wins. `RESET_SEQ` prevents overflow on long-lived streams.

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
      virtual-socket.js     # Multipath layer: duplication & dedup
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
```

## Tests

```bash
npm run test                 # Core test suite
npm run test:all             # Full suite including SSE timeout tests
node --test tests/e2e/tls-mtls/test-multipath.js   # just multipath
```

## License

MIT

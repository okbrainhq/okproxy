# tunzero

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

Create `.deploy.server`:

```bash
HOSTNAME=tunnel.example.com
REPO_URL=https://github.com/arunoda/tunzero.git
```

Deploy:

```bash
./scripts/deploy/setup-server.sh user@server --upload-certs   # first time
./scripts/deploy/setup-server.sh user@server                  # updates
```

Server ports: 80 (HTTP), 443 (HTTPS via Caddy), 9443 (TLS tunnel)

## Client Deployment (macOS)

Create `.deploy.client`:

```bash
SERVER_HOST=t0.arunoda.me:9443
TARGET_HOST=localhost:3000
REPO_URL=https://github.com/arunoda/tunzero.git
```

Deploy:

```bash
./scripts/deploy/setup-client.sh user@192.168.0.15 --upload-certs
```

The client runs as a LaunchAgent with `--multipath` enabled by default, auto-starts on login, and restarts on crash.

```bash
# Manage on the Mac
launchctl list com.tunzero.client
launchctl stop com.tunzero.client
tail -f ~/.tunzero/logs/client.log
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
```

## Client Options

```
--server <host:port>        Tunnel server (default: localhost:9443)
--target <host:port>        Local target service (default: localhost:3000)
--key <path>                Client private key
--cert <path>               Client certificate
--ca <path>                 CA certificate
--multipath                 Enable multipath over all available interfaces
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

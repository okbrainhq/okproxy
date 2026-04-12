# TCP Tunnel (TLS + mTLS)

A secure ngrok alternative using TLS encryption with mutual TLS (mTLS) authentication. **Zero third-party dependencies** - only Node.js built-in modules.

**Features:**

- **TLS 1.2+ encryption** - Strong encryption for all tunnel traffic
- **Mutual TLS (mTLS)** - Server verifies client certificate, client verifies server certificate
- **Multiplexing** - Multiple concurrent HTTP requests over single TLS connection
- **Streaming** - Supports streaming responses and large file transfers
- **SSE support** - Server-Sent Events work natively
- **Auto-reconnection** - Client automatically reconnects with exponential backoff
- **Backpressure** - Flow control when network or target is slow
- **Keepalive** - PING/PONG detects dead connections
- **CORS** - Automatic CORS headers for cross-origin browser requests
- **Caddy SSL** - Automatic HTTPS with Let's Encrypt certificates via Caddy
- **Certificate revocation** - Server checks revocation list on each connection
- **Auto-expiry** - Certificates have built-in expiration (enforced by TLS)

## Local Keys Generation

The tunnel requires a Certificate Authority (CA) and certificates for both server and client.

```bash
# Initialize the CA (one-time setup)
node apps/server/bin/tunnel-ca.js init

# Issue server certificate (for localhost or your domain)
node apps/server/bin/tunnel-ca.js issue-server --hostname localhost --output ./.certs

# Issue client certificate
node apps/server/bin/tunnel-ca.js issue-client
```

This creates:
- `.ca/` - CA private key and certificate
- `.certs/` - Server and client keys/certificates

### CA Commands Reference

```bash
# Initialize CA (creates .ca/ directory)
node apps/server/bin/tunnel-ca.js init

# Issue server certificate with SAN for hostname validation
node apps/server/bin/tunnel-ca.js issue-server \
  --hostname <domain> \
  [--output <dir>]

# Issue client certificate
node apps/server/bin/tunnel-ca.js issue-client \
  [--output <dir>]

# List all issued certificates
node apps/server/bin/tunnel-ca.js list

# Revoke a certificate by serial number
node apps/server/bin/tunnel-ca.js revoke --serial <number>
```

### Default Directory Structure

```
.ca/                       # CA files (auto-generated, should be kept secure)
  ca-key.pem              # CA private key
  ca-cert.pem             # CA certificate
  crl.txt                 # Certificate revocation list
  issued.txt              # Issued certificates log
  serial-counter.txt      # Serial number counter

.certs/                    # Certificates (default output location)
  server-key.pem          # Server private key
  server-cert.pem         # Server certificate
  client-key.pem          # Client private key
  client-cert.pem         # Client certificate
  ca-cert.pem             # Copy of CA certificate (for client)
```

### Certificate Structure

| Certificate | Validity | Usage |
|-------------|----------|-------|
| CA | 10 years | Sign client/server certs |
| Server | 1 year | TLS server authentication |
| Client | 90 days | TLS client authentication |

### Certificate Rotation

Client certificates expire after 90 days. To rotate without downtime:

1. Issue a new certificate: `tunnel-ca.js issue-client`
2. Deploy the new certificate to the client
3. The client reconnects with the new certificate
4. (Optional) Revoke the old certificate: `tunnel-ca.js revoke --serial <old>`

Both old and new certificates work during the overlap period since revocation is by serial number.

## Local & Server & Client Deployment

### 1. Start the Tunnel Server

With default certificate paths (`.certs/server-key.pem`, `.certs/server-cert.pem`, `.ca/ca-cert.pem`):

```bash
node apps/server/index.js
```

With custom paths:

```bash
node apps/server/index.js \
  --key ./custom/server-key.pem \
  --cert ./custom/server-cert.pem \
  --ca ./.ca/ca-cert.pem
```

Options:
- `--http-port` - Public HTTP port (default: 8080)
- `--tls-port` - TLS tunnel port (default: 9443)
- `--key` - Server private key (default: `./.certs/server-key.pem`)
- `--cert` - Server certificate (default: `./.certs/server-cert.pem`)
- `--ca` - CA certificate for verifying clients (default: `./.ca/ca-cert.pem`)
- `--ca-dir` - CA directory for revocation checks (default: `./.ca`)

### 2. Start Your Local Service

```bash
# Example: Python HTTP server on port 3000
python -m http.server 3000
```

### 3. Start the Tunnel Client

With default certificate paths (`.certs/client-key.pem`, `.certs/client-cert.pem`, `.ca/ca-cert.pem`):

```bash
node apps/client/index.js --target localhost:3000
```

With custom paths:

```bash
node apps/client/index.js \
  --server localhost:9443 \
  --target localhost:3000 \
  --key ./custom/client-key.pem \
  --cert ./custom/client-cert.pem \
  --ca ./.ca/ca-cert.pem
```

Options:
- `--server` - Tunnel server address (default: localhost:9443)
- `--target` - Your local service address (default: localhost:3000)
- `--key` - Client private key (default: `./.certs/client-key.pem`)
- `--cert` - Client certificate (default: `./.certs/client-cert.pem`)
- `--ca` - CA certificate for verifying server (default: `./.ca/ca-cert.pem`)

### 4. Access Your Service

```bash
# The tunnel forwards all paths directly to your local service
curl http://localhost:8080/your-endpoint
curl http://localhost:8080/api/users
curl http://localhost:8080/some/path?query=value
```

## Prod Server Deployment

Deploy the tunnel server to a Debian-based server with systemd, Caddy (for SSL), and automatic security hardening.

### Prerequisites

- Debian/Ubuntu server with SSH access
- Domain name pointing to your server (for SSL)
- `rsync` installed on your local machine

### 1. Create Configuration File

Create `.deploy.server` in the project root:

```bash
# .deploy.server
HOSTNAME=tunnel.example.com
REPO_URL=https://github.com/username/tunzero.git
```

**Note:** Add `.deploy.server` to `.gitignore` - never commit deployment credentials.

### 2. Deploy

From your local machine:

```bash
# First deployment - with certificates uploaded from local
./scripts/deploy/setup-server.sh user@server --upload-certs

# Subsequent deployments (updates) - pull latest code and restart
./scripts/deploy/setup-server.sh user@server
```

The script is idempotent - running it multiple times is safe. It will:
- Install Node.js 20, Caddy, Fail2Ban, UFW
- Clone or pull the repository
- Generate or reuse certificates
- Configure systemd service with auto-restart
- Set up Caddy for HTTPS with automatic SSL
- Harden SSH (no root login, no passwords)
- Configure firewall (allow 22, 80, 443, 9443)
- Run health checks

### Server Ports

| Port | Purpose |
|------|---------|
| 22 | SSH access |
| 80 | HTTP (redirects to HTTPS) |
| 443 | HTTPS (Caddy + tunzero HTTP server) |
| 9443 | TLS tunnel (clients connect here) |

### Updating the Server

To deploy a newer version, simply re-run the script:

```bash
./scripts/deploy/setup-server.sh user@server
```

This will:
1. Pull the latest code from the repository
2. Restart the systemd service
3. Run health checks

### Viewing Logs

On the remote server:

```bash
# View service status
systemctl status tunzero

# Follow logs
journalctl -u tunzero -f

# View recent logs
journalctl -u tunzero -n 100
```

## Prod Client Deployment on MacOS

To run the tunnel client as a background service on macOS using `launchd`.

### 1. Create LaunchAgent plist file

Create a plist file at `~/Library/LaunchAgents/com.tunzero.client.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tunzero.client</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOUR_USERNAME/path/to/tunzero/apps/client/index.js</string>
    <string>--server</string>
    <string>your-server.com:9443</string>
    <string>--target</string>
    <string>localhost:3000</string>
    <string>--key</string>
    <string>/Users/YOUR_USERNAME/.tunzero/client-key.pem</string>
    <string>--cert</string>
    <string>/Users/YOUR_USERNAME/.tunzero/client-cert.pem</string>
    <string>--ca</string>
    <string>/Users/YOUR_USERNAME/.tunzero/ca-cert.pem</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.tunzero/logs/tunzero-out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.tunzero/logs/tunzero-err.log</string>
</dict>
</plist>
```

**Replace:**
- `YOUR_USERNAME` with your macOS username
- `/path/to/tunzero` with the actual path to your tunzero installation
- Server and certificate paths as needed

### 2. Prepare Directories and Certificates

```bash
# Create directories
mkdir -p ~/.tunzero/logs

# Copy certificates (adjust source paths as needed)
cp /path/to/certs/client-key.pem ~/.tunzero/
cp /path/to/certs/client-cert.pem ~/.tunzero/
cp /path/to/certs/ca-cert.pem ~/.tunzero/
```

### 3. Load and Start the Service

```bash
# Load the launch agent
launchctl load ~/Library/LaunchAgents/com.tunzero.client.plist

# Start the service
launchctl start com.tunzero.client

# Check if it's running
launchctl list | grep com.tunzero
```

### 4. Managing the Service

```bash
# Stop the service
launchctl stop com.tunzero.client

# Start the service
launchctl start com.tunzero.client

# Unload the service
launchctl unload ~/Library/LaunchAgents/com.tunzero.client.plist

# Reload after making changes
launchctl unload ~/Library/LaunchAgents/com.tunzero.client.plist
launchctl load ~/Library/LaunchAgents/com.tunzero.client.plist
```

### 5. Viewing Logs

```bash
# View stdout logs
tail -f ~/.tunzero/logs/tunzero-out.log

# View stderr logs
tail -f ~/.tunzero/logs/tunzero-err.log

# View both
open ~/.tunzero/logs
```

### Automatic Start on Login

The `RunAtLoad` and `KeepAlive` keys in the plist ensure the service:
- Starts automatically when you log in
- Restarts if it crashes or stops unexpectedly

To disable auto-start, unload the service:

```bash
launchctl unload ~/Library/LaunchAgents/com.tunzero.client.plist
```

## Directory Structure

```
/apps/
  /server/               # Tunnel server
    index.js             # CLI entry (TLS-only)
    lib/
      tls-server.js      # TLS socket handling with mTLS
      http-router.js     # HTTP → tunnel routing
      client-manager.js  # Single client tracking
      ca.js              # Certificate Authority functions
    bin/
      tunnel-ca.js       # CA management CLI
  /client/               # Tunnel client
    index.js             # CLI entry (TLS-only)
    lib/
      tls-connection.js  # TLS connection + reconnect
      proxy.js           # HTTP proxy to local target
/packages/
  /frame-protocol/       # Shared framing protocol
    index.js             # Encoder/decoder
/scripts/
  /deploy/               # Deployment scripts
    setup-server.sh      # Server deployment script
/tests/
  /e2e/tls-mtls/         # TLS end-to-end tests

.ca/                     # CA files (auto-generated)
.certs/                  # Certificates (default location)
```

## Protocol Details

### Custom Framing Protocol

The tunnel uses a 9-byte header framing protocol over TLS:

```
┌──────────────┬─────────┬──────────┬─────────────┐
│ Stream ID    │ Type    │ Length   │ Payload     │
│ 4 bytes      │ 1 byte  │ 4 bytes  │ N bytes     │
└──────────────┴─────────┴──────────┴─────────────┘
```

**Frame Types:**
- `0x01` HEADERS - HTTP metadata (JSON)
- `0x02` DATA - Body chunk
- `0x03` FIN - Stream complete
- `0x04` ERROR - Stream error
- `0x05` INIT - Connection handshake
- `0x06` PING - Keepalive ping
- `0x07` PONG - Keepalive response

### TLS Handshake

```
1. TCP connect
2. TLS handshake (mutual certificate exchange)
   → Server validates client cert (CA-signed, not expired, not revoked)
   → Client validates server cert
3. INIT frame exchange (protocol version, maxFrameSize negotiation)
4. Ready for streams
```

### INIT Handshake

On connect, client sends:
```
INIT frame (streamId=0): { version: 1, maxFrameSize: 1048576 }
```

Server responds:
```
INIT frame (streamId=0): { version: 1, maxFrameSize: 1048576, maxConcurrentStreams: 100 }
```

No requests can be sent until INIT completes.

### HTTP Request Flow

1. HTTP client sends `GET /api/users` to public server
2. Server creates stream (e.g., streamId=1), sends HEADERS frame to tunnel client
3. Client receives HEADERS, makes request to local target
4. Client sends response back: HEADERS → DATA → FIN frames
5. Server forwards response to HTTP client

### Keepalive

- Server sends PING every 30 seconds of inactivity
- Client must respond with PONG within 10 seconds
- Dead connections are cleaned up automatically

### CORS (Cross-Origin Resource Sharing)

The tunnel server automatically adds CORS headers to all responses:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Accept, Origin
Access-Control-Allow-Credentials: true
```

This allows browser-based apps to make API requests through the tunnel without CORS errors. Preflight OPTIONS requests are handled automatically (returns 204).

## Running Tests

```bash
# Run all TLS e2e tests
node tests/e2e/tls-mtls/run.js

# Run specific test file
node --test tests/e2e/tls-mtls/test-frames.js
```

## Example: Full Setup

Terminal 1 - Initialize CA and generate certificates:
```bash
$ node apps/server/bin/tunnel-ca.js init
CA initialized
CA Certificate: .ca/ca-cert.pem

$ node apps/server/bin/tunnel-ca.js issue-server --hostname localhost --output ./.certs
Server certificate issued for localhost
  Key: .certs/server-key.pem
  Cert: .certs/server-cert.pem

$ node apps/server/bin/tunnel-ca.js issue-client
Client certificate issued (serial: 1)
  Key: .certs/client-key.pem
  Cert: .certs/client-cert.pem
  CA: .certs/ca-cert.pem
```

Terminal 2 - Start server (uses default paths):
```bash
$ node apps/server/index.js
Starting TLS tunnel server...
TLS tunnel server listening on port 9443
HTTP server listening on port 8080
```

Terminal 3 - Start a local service:
```bash
$ python -m http.server 3000
Serving HTTP on 0.0.0.0 port 3000
```

Terminal 4 - Start tunnel client (uses default paths):
```bash
$ node apps/client/index.js --target localhost:3000
Starting TLS tunnel client...
Server: localhost:9443
Target: localhost:3000
Connected to TLS tunnel server
```

Terminal 5 - Test:
```bash
# This hits your local Python server through the secure tunnel
$ curl http://localhost:8080/
<!DOCTYPE HTML>
<html>
<head>
    <title>Directory listing for /</title>
...
```

## Limitations

- **Single client only** - Server accepts only one tunnel connection at a time
- **No WebSocket support** - WebSocket connections are not supported (use SSE instead)
- **Node.js only** - Server and client both require Node.js
- **openssl required** - CA operations require openssl CLI in PATH

## License

MIT

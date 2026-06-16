# Deployment Script Design

## Overview

A deployment script to deploy the okproxy tunnel server to any Debian-based server using systemd and Caddy for SSL.

## Script Location

- `scripts/deploy/setup-server.sh` - Local orchestration script (run from your machine)
- `scripts/deploy/setup-server-remote.sh` - Remote setup script (run on the server)

## Configuration File

Create a `.deploy.server` file in the project root to specify deployment parameters:

```bash
# .deploy.server - Deployment configuration
# HOSTNAME: The domain name for the tunnel server (used by Caddy for SSL)
HOSTNAME=tunnel.example.com
# REPO_URL: Git repository URL to clone the application
REPO_URL=https://github.com/username/okproxy.git
# Optional: Git branch to deploy (default: main)
BRANCH=main
```

The script reads this file to get `HOSTNAME`, `REPO_URL`, and optional `BRANCH`.

**Note:** Add `.deploy.server` to `.gitignore` to prevent accidental commits of deployment credentials.

### HOSTNAME Usage

The `HOSTNAME` value is used for:
1. **Caddy SSL** - Caddy obtains Let's Encrypt certificates for this domain
2. **Caddy Site Configuration** - Creates a site block in the Caddyfile
3. **Server Certificate** - When generating certs on the server, the hostname is included in the server certificate's SAN (Subject Alternative Name)

**Prerequisite:** You must point this domain's DNS A/AAAA records to the server's IP address before running the deployment script. Caddy needs this to verify domain ownership for SSL.

## Parameters / Flags

- `--upload-certs` - Upload local `.certs/` and `.ca/` directories to the server
- `--dev` - Local development mode (skip production-only steps)

## Usage Examples

### Production Deployment (Remote Server)

From your **local machine**, use the orchestration script:

```bash
# Deploy to remote server (uses .deploy.server for config)
./scripts/deploy/setup-server.sh user@server --upload-certs

# Deploy without uploading certs (generate on server)
./scripts/deploy/setup-server.sh user@server
```

### Local Development Setup

Run directly on your local machine:

```bash
./scripts/deploy/setup-server-remote.sh --dev
```

## Scripts Architecture

Two scripts work together for remote deployment:

| Script | Location | Purpose |
|--------|----------|---------|
| `setup-server.sh` | Local machine | Orchestration - copies scripts to server, executes setup-server-remote.sh |
| `setup-server-remote.sh` | Remote server | Actual setup - installs dependencies, configures systemd, Caddy |

### Local Orchestration Flow (setup-server.sh)

1. Read `.deploy.server` for `HOSTNAME`, `REPO_URL`, and optional `BRANCH`
2. Copy `setup-server-remote.sh` to remote server
3. If `--upload-certs`: scp certificates to remote server
4. SSH into server and run: `sudo ./setup-server-remote.sh [hostname] [repo_url] --branch=[branch] [flags]`

### Remote Execution Context (setup-server-remote.sh)

| Step | Runs As | Notes |
|------|---------|-------|
| User detection | Any | `REAL_USER=${SUDO_USER:-$USER}` |
| Config loading | root (sudo) | Validate `.deploy.server` loaded |
| System prep | root (sudo) | apt install, nodejs setup |
| Cert generation | `$REAL_USER` | Run `tunnel-ca.js` commands |
| App deployment | `$REAL_USER` | git clone/pull, directory setup |
| Systemd setup | root (sudo) | Service file with `User=$REAL_USER` |
| Caddy config | root (sudo) | SSL certificate acquisition |
| Security hardening | root (sudo) | Firewall, fail2ban, SSH config |
| Health check | `$REAL_USER` | Verify service status |

### User Detection

The script detects the target user for service execution:

```bash
# Detect real user if running with sudo
REAL_USER=${SUDO_USER:-$USER}
echo "Configuring for user: $REAL_USER"
```

This ensures:
- If run with `sudo`: uses the user who invoked sudo (e.g., `deploy` user)
- If run directly: uses current `$USER`
- The systemd service runs as `$REAL_USER`, not root
- File ownership is set to `$REAL_USER:$REAL_USER`

## Deployment Steps

### 1. Configuration Loading

- Check if `.deploy.server` exists
- Source the file to load `HOSTNAME`, `REPO_URL`, and optional `BRANCH`
- Validate required variables are set (unless `--dev` mode)

### 2. System Preparation

- Update apt
- Install basic tools: curl, git, unzip
- Install Node.js 20.x

### 3. Certificate Handling

**If `--upload-certs` flag is provided:**
- Check local `.certs/` and `.ca/` directories exist
- Use scp to upload certificates to `/var/www/okproxy/certs/` on server

**If flag NOT provided (production):**
- Run `node apps/server/bin/tunnel-ca.js init` on server
- Run `node apps/server/bin/tunnel-ca.js issue-server --hostname $HOSTNAME --output ./.certs`
- Run `node apps/server/bin/tunnel-ca.js issue-client`

**If `--dev` mode:**
- Skip certificate setup (developer handles manually)

### 4. Application Deployment

- Create `/var/www/okproxy` directory
- Clone/update repository from `$REPO_URL` using `$BRANCH` (defaults to `main`)
- Set ownership to `$REAL_USER`

**Note on monorepo structure:** The okproxy project uses a monorepo with `apps/server/` and `packages/frame-protocol/`. The server imports from `../../packages/frame-protocol/index.js`. Since `apps/server/package.json` has zero dependencies, `npm install` is not required - the code runs directly via Node.js built-in modules. The shared package is automatically available after cloning the repository.

### 5. Systemd Service Setup

Create `/etc/systemd/system/okproxy.service`:

```ini
[Unit]
Description=Tunzero Tunnel Server
After=network.target

[Service]
Type=simple
User=<REAL_USER>
WorkingDirectory=/var/www/okproxy/apps/server
ExecStart=/usr/bin/node index.js --http-port 8080 --tls-port 9443
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Commands:
- `systemctl daemon-reload`
- `systemctl enable okproxy`
- `systemctl restart okproxy` (idempotent: works whether service is running or not)

### 6. Caddy Configuration

Install Caddy if not present, then configure `/etc/caddy/Caddyfile`:

```
$HOSTNAME {
    reverse_proxy localhost:8080
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
}
```

Reload Caddy: `systemctl reload caddy`

### 7. Security Hardening

#### SSH Hardening
- Disable password authentication: `PasswordAuthentication no`
- Disable root login: `PermitRootLogin no`
- Disable challenge-response auth: `ChallengeResponseAuthentication no`
- Validate config with `sshd -t` before restarting
- Keep backup: `cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak`

#### Firewall (UFW)
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (redirects to HTTPS)
ufw allow 443/tcp   # HTTPS (Caddy)
ufw allow 9443/tcp  # TLS tunnel (okproxy clients)
ufw --force enable
```

#### Fail2Ban
```ini
# /etc/fail2ban/jail.local
[DEFAULT]
bantime  = 24h
findtime = 10m
maxretry = 3

[sshd]
enabled = true
backend = systemd
```

#### Unattended Upgrades
```bash
apt install -y unattended-upgrades
# Enable automatic security updates
echo "unattended-upgrades unattended-upgrades/enable_auto_updates boolean true" | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades
```

**Note:** Unattended-upgrades does NOT auto-reboot by default. For auto-reboot on kernel updates:
```bash
# /etc/apt/apt.conf.d/50unattended-upgrades
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
```

Consider whether auto-reboot is acceptable for your use case (tunnel will be briefly unavailable).

### 8. Idempotency & Re-run Safety

The script must handle being run multiple times safely:

| Operation | Idempotent Approach |
|-----------|---------------------|
| Git clone/update | `if [ -d "$APP_DIR/.git" ]; then git fetch origin "$BRANCH"; git reset --hard "origin/$BRANCH"; else git clone --branch "$BRANCH"; fi` |
| Directory creation | `mkdir -p` (always succeeds) |
| Systemd service | Use `systemctl restart` (works whether stopped or running) |
| Caddy config | Overwrite file, then `systemctl reload caddy` |
| Package installation | `apt install` is naturally idempotent |
| Certificate generation | Check if certs exist before running `tunnel-ca.js` |

### 9. Health Check

After deployment, verify the service is working:

```bash
# Check systemd service status
systemctl is-active okproxy || exit 1

# Check HTTP endpoint (with retry)
for i in 1 2 3; do
    if curl -sf http://localhost:8080/health || curl -sf http://localhost:8080/; then
        echo "Service is healthy"
        break
    fi
    sleep 2
done

# Check TLS port is listening
ss -tlnp | grep -q ':9443' || echo "Warning: TLS port 9443 not listening"
```

If health check fails, show logs: `journalctl -u okproxy -n 50 --no-pager`

## Server Directory Structure

```
/var/www/okproxy/
├── apps/
│   └── server/          # Main application code
│       ├── index.js
│       ├── lib/
│       └── bin/
├── .certs/             # Server & client certificates
│   ├── server-key.pem
│   ├── server-cert.pem
│   ├── client-key.pem
│   ├── client-cert.pem
│   └── ca-cert.pem
└── .ca/                # CA files
    ├── ca-key.pem
    ├── ca-cert.pem
    ├── crl.txt
    ├── issued.txt
    └── serial-counter.txt
```

## Key Differences from Brain Script

| Feature | Brain Script | OKProxy Script |
|---------|-------------|----------------|
| Config source | Command line args | `.deploy.server` file |
| Process manager | PM2 | systemd native |
| Certificates | Generated on server | Optional `--upload-certs` from local |
| App complexity | Multi-service with sandbox | Simple single Node.js server |
| Sandbox user | Yes (brain-sandbox) | No |
| SSH port in firewall | 22 only | 22 + 9443 (tunnel port) |

## Log Management

- All logs go to systemd journal (`journalctl -u okproxy`)
- No additional log rotation needed (systemd handles it)
- **Journal size cap** (recommended for long-running servers):

```bash
# /etc/systemd/journald.conf
[Journal]
SystemMaxUse=500M
MaxFileSec=1week
```

This prevents disk exhaustion from accumulating logs. Apply with: `systemctl restart systemd-journald`

## Certificate Renewal

- Server certificates: Use `--upload-certs` to deploy new certs, then `systemctl restart okproxy`
- Client certificates: Distributed to clients separately

## Security Considerations

The `apps/server/lib/ca.js` module uses `execFileSync` with arrays (safe from shell injection) rather than `execSync` with string interpolation. Additional hostname validation has been added to prevent any potential injection in the certificate subject field.

**Validation applied:**
- Hostname must match: `^[a-zA-Z0-9.-]+$`
- No leading/trailing dots or hyphens
- No consecutive dots (`..`)
- Invalid hostnames throw an error before any OpenSSL commands are executed

This ensures the deployment script safely handles the `$HOSTNAME` value from `.deploy.server` when generating certificates.

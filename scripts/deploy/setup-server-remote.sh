#!/bin/bash

# setup-server-remote.sh
# Purpose: Installs dependencies and prepares the environment for okproxy on Debian.
# Usage:
#   Production: ./setup-server-remote.sh <HOSTNAME> <REPO_URL> [--branch=<branch>] [--cert-bound-domains=true|false]
#   Dev:        ./setup-server-remote.sh --dev

set -eo pipefail

# Parse flags
DEV_MODE=false
CERT_BOUND_DOMAINS=true
BRANCH="main"
POSITIONAL=()

while [ $# -gt 0 ]; do
    case "$1" in
        --dev)
            DEV_MODE=true
            shift
            ;;
        --cert-bound-domains=false)
            CERT_BOUND_DOMAINS=false
            shift
            ;;
        --cert-bound-domains=true|--cert-bound-domains)
            CERT_BOUND_DOMAINS=true
            shift
            ;;
        --branch=*)
            BRANCH="${1#--branch=}"
            shift
            ;;
        --branch)
            if [ $# -lt 2 ]; then
                echo "Error: --branch requires a branch name"
                exit 1
            fi
            BRANCH="$2"
            shift 2
            ;;
        --*)
            # Unknown flag
            shift
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

APP_DIR="/opt/okproxy"

if [ "$DEV_MODE" = false ]; then
    if [ ${#POSITIONAL[@]} -lt 2 ]; then
        echo "Error: Hostname and repository URL are required."
        echo "Usage:"
        echo "  Production: ./remote-setup.sh <HOSTNAME> <REPO_URL> [--branch=<branch>]"
        echo "  Dev:        ./remote-setup.sh --dev"
        exit 1
    fi
    if [ -z "$BRANCH" ]; then
        echo "Error: Branch name cannot be empty."
        exit 1
    fi
    HOSTNAME="${POSITIONAL[0]}"
    REPO_URL="${POSITIONAL[1]}"
    echo "Starting setup for OKProxy (production)..."
    echo "Target Directory: $APP_DIR"
    echo "Repository: $REPO_URL"
    echo "Branch: $BRANCH"
    echo "Hostname: $HOSTNAME"
    echo "Cert-bound domains: $CERT_BOUND_DOMAINS"
else
    echo "Starting setup for OKProxy (dev mode)..."
fi

# Detect real user if running with sudo
REAL_USER=${SUDO_USER:-$USER}
echo "Configuring for user: $REAL_USER"

# Check sudo access
echo "Checking sudo access..."
if ! sudo -n true 2>/dev/null; then
    echo "ERROR: This setup requires sudo access without interactive password prompts."
    echo "Ensure this user has sudo privileges, then re-run setup."
    exit 1
fi

# ============================================================
# Shared steps (both dev and production)
# ============================================================

# 1. Update APT
echo "Updating apt..."
sudo apt update

# 2. Install basic tools
echo "Installing basic tools (curl, git, unzip)..."
sudo apt install -y curl git unzip

if [ "$DEV_MODE" = false ]; then
    if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
        echo "Error: Invalid branch name: $BRANCH"
        exit 1
    fi
fi

# 3. Install/Update Node.js (Latest LTS)
echo "Checking Node.js status..."

# If OKPROXY_NODE_PATH is set, verify it exists and skip all detection and installation
if [ -n "$OKPROXY_NODE_PATH" ]; then
    if [ -x "$OKPROXY_NODE_PATH" ]; then
        echo "Using custom Node.js path from OKPROXY_NODE_PATH: $OKPROXY_NODE_PATH"
        echo "Skipping Node.js detection and installation."
        NODE_PATH="$OKPROXY_NODE_PATH"
        # Skip the entire install block - will jump to end of section
        SKIP_NODE_INSTALL=true
    else
        echo "Error: OKPROXY_NODE_PATH is set but executable not found: $OKPROXY_NODE_PATH"
        exit 1
    fi
else
    SKIP_NODE_INSTALL=false
fi

# Only run detection and installation if not using custom path
if [ "$SKIP_NODE_INSTALL" = false ]; then

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        NODE_ARCH="linux-x64"
        ;;
    aarch64|arm64)
        NODE_ARCH="linux-arm64"
        ;;
    *)
        echo "Error: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Fetch latest LTS version from official Node.js releases JSON
# Filter for entries where "lts" is a string (not false) and extract version
LTS_DATA=$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null | head -c 10000 || echo "")

if [ -n "$LTS_DATA" ]; then
    # Find first entry with "lts":"codename" (not "lts":false)
    # Extract the version from the first LTS entry
    TARGET_VERSION=$(echo "$LTS_DATA" | grep -oE '\{"version":"v[0-9]+\.[^}]*"lts":"[^"]+"[^}]*\}' | head -1 | grep -oE '"version":"v[0-9]+' | grep -oE 'v[0-9]+')
    TARGET_MAJOR=$(echo "$TARGET_VERSION" | grep -oE '[0-9]+')

    if [ -n "$TARGET_MAJOR" ]; then
        TARGET_NODE_VERSION="v${TARGET_MAJOR}"
        echo "Latest LTS detected: Node.js ${TARGET_NODE_VERSION}.x"
    else
        # Fallback to v22 if detection fails
        TARGET_NODE_VERSION="v22"
        TARGET_MAJOR="22"
        echo "Could not detect latest LTS. Using fallback: Node.js ${TARGET_NODE_VERSION}"
    fi
else
    # Fallback to v22 if API is unreachable
    TARGET_NODE_VERSION="v22"
    TARGET_MAJOR="22"
    echo "Could not fetch LTS info. Using fallback: Node.js ${TARGET_NODE_VERSION}"
fi

# Check only our custom Node.js installation at /usr/local/bin/node (ignore system Node.js)
INSTALL_NODE=false

if [ -x "/usr/local/bin/node" ]; then
    CURRENT_NODE_VERSION=$(/usr/local/bin/node -v)
    echo "Found custom Node.js installation: ${CURRENT_NODE_VERSION}"

    # Check if current major version matches target
    if [[ "${CURRENT_NODE_VERSION}" == ${TARGET_NODE_VERSION}* ]]; then
        echo "Node.js is already at target LTS version ${TARGET_NODE_VERSION}."
        INSTALL_NODE=false
    else
        echo "Node.js version mismatch. Target: ${TARGET_NODE_VERSION}, Current: ${CURRENT_NODE_VERSION}"
        echo "Will update to Node.js ${TARGET_NODE_VERSION}..."
        INSTALL_NODE=true
    fi
else
    echo "Custom Node.js not found at /usr/local/bin/node. Will install Node.js ${TARGET_NODE_VERSION}..."
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
    echo "Installing Node.js ${TARGET_NODE_VERSION}.x from official Node.js distribution..."

    # Warn if system Node.js exists (before we start installing)
    if command -v node &> /dev/null; then
        echo "Note: Node.js also found in PATH, system package manager version may coexist."
    fi

    NODE_VERSION_FULL=$(curl -fsSL "https://nodejs.org/dist/latest-${TARGET_NODE_VERSION}.x/" 2>/dev/null | grep -oE "node-${TARGET_NODE_VERSION}\.[0-9]+\.[0-9]+-${NODE_ARCH}\.tar\.gz" | head -1 | sed "s/node-//;s/-${NODE_ARCH}\.tar\.gz//")
    if [ -z "$NODE_VERSION_FULL" ]; then
        # Fallback to known version if detection fails
        NODE_VERSION_FULL="${TARGET_NODE_VERSION}.15.0"
        echo "Could not detect latest ${TARGET_NODE_VERSION}.x version. Using fallback: ${NODE_VERSION_FULL}"
    else
        echo "Installing Node.js ${NODE_VERSION_FULL}..."
    fi

    NODE_TARBALL="node-${NODE_VERSION_FULL}-${NODE_ARCH}.tar.gz"
    # NODE_VERSION_FULL already includes 'v' prefix, don't add another
    NODE_URL="https://nodejs.org/dist/${NODE_VERSION_FULL}/${NODE_TARBALL}"
    SHASUMS_URL="https://nodejs.org/dist/${NODE_VERSION_FULL}/SHASUMS256.txt"

    # Create temp directory for downloads
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT

    # Download tarball and checksums
    echo "Downloading Node.js ${NODE_VERSION_FULL} for ${ARCH}..."
    curl -fsSL "$NODE_URL" -o "$TEMP_DIR/$NODE_TARBALL"
    curl -fsSL "$SHASUMS_URL" -o "$TEMP_DIR/SHASUMS256.txt"

    # Verify SHA256 checksum
    echo "Verifying SHA256 checksum..."
    EXPECTED_HASH=$(grep "$NODE_TARBALL" "$TEMP_DIR/SHASUMS256.txt" | awk '{print $1}')
    if [ -z "$EXPECTED_HASH" ]; then
        echo "Error: Could not find checksum for $NODE_TARBALL"
        exit 1
    fi

    ACTUAL_HASH=$(sha256sum "$TEMP_DIR/$NODE_TARBALL" | awk '{print $1}')
    if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
        echo "Error: SHA256 checksum verification failed!"
        echo "Expected: $EXPECTED_HASH"
        echo "Actual:   $ACTUAL_HASH"
        exit 1
    fi
    echo "SHA256 checksum verified."

    # Remove any existing Node.js installation
    if [ -d "/usr/local/lib/node" ]; then
        echo "Removing existing Node.js installation..."
        sudo rm -rf /usr/local/lib/node /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null || true
    fi

    # Extract tarball to /usr/local
    echo "Extracting Node.js to /usr/local..."
    sudo tar -xz -C /usr/local --strip-components=1 -f "$TEMP_DIR/$NODE_TARBALL"

    # Verify installation
    if [ -x "/usr/local/bin/node" ]; then
        echo "Node.js installed successfully: $(/usr/local/bin/node -v)"
        echo "npm version: $(/usr/local/bin/npm -v)"
    else
        echo "Error: Node.js installation failed"
        exit 1
    fi

# End of INSTALL_NODE block
fi
# End of SKIP_NODE_INSTALL wrapper
fi

# Determine the Node.js executable path to use in systemd service
if [ -z "$NODE_PATH" ]; then
    NODE_PATH="/usr/local/bin/node"
fi
if [ ! -x "$NODE_PATH" ]; then
    echo "Error: Node.js executable not found at $NODE_PATH"
    echo "Install Node.js first, or set OKPROXY_NODE_PATH to the correct binary"
    exit 1
fi
echo "Using Node.js at: $NODE_PATH ($($NODE_PATH -v))"

# ============================================================
# Production-only steps (skipped in --dev mode)
# ============================================================

if [ "$DEV_MODE" = false ]; then

    # 4. Install Caddy
    if ! command -v caddy &> /dev/null; then
        echo "Caddy not found. Installing Caddy..."
        sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
        sudo apt update
        sudo apt install -y caddy
    else
        echo "Caddy is already installed: $(caddy version)"
    fi

    # 5. Clone or update repository
    CERT_DIR="/opt/okproxy/certs"
    CA_DIR="/opt/okproxy/ca"
    if [ -d "$APP_DIR/.git" ]; then
        echo "App directory exists. Updating repository from branch $BRANCH..."
        # The app directory is owned by the okproxy service user after setup.
        # Since this script runs via sudo, Git may reject it as "dubious ownership".
        git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
        cd "$APP_DIR"
        git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
        git checkout -B "$BRANCH" "origin/$BRANCH"
        git reset --hard "origin/$BRANCH"
        echo "Repository updated."
    else
        echo "App directory does not exist. Cloning repository branch $BRANCH..."
        if [ -d "$APP_DIR" ]; then
            sudo rm -rf "$APP_DIR"
        fi
        sudo mkdir -p "$(dirname "$APP_DIR")"
        sudo chown -R "$REAL_USER":"$REAL_USER" "$(dirname "$APP_DIR")"
        git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
        echo "Repository cloned."
    fi

    # Create dedicated okproxy system user if it doesn't exist
    if ! id -u okproxy &>/dev/null; then
        echo "Creating dedicated okproxy system user..."
        sudo useradd --system --no-create-home --shell /usr/sbin/nologin okproxy
    else
        echo "okproxy user already exists"
    fi

    # Set proper ownership for app and cert directories
    sudo chown -R okproxy:okproxy "$APP_DIR"
    sudo mkdir -p "$CERT_DIR" "$CA_DIR"
    sudo chown -R okproxy:okproxy "$CERT_DIR" "$CA_DIR"

    fix_cert_permissions() {
        # okproxy.service runs as User=okproxy, so private keys must be readable by okproxy.
        for dir in "$CERT_DIR" "$CA_DIR" "$APP_DIR/.certs" "$APP_DIR/.ca"; do
            if [ -d "$dir" ]; then
                sudo chown -R okproxy:okproxy "$dir"
                sudo chmod 700 "$dir"
            fi
        done
        for key in "$CERT_DIR/server-key.pem" "$APP_DIR/.certs/server-key.pem"; do
            if [ -f "$key" ]; then
                sudo chmod 600 "$key"
            fi
        done
        for cert in "$CERT_DIR/server-cert.pem" "$CERT_DIR/ca-cert.pem" "$APP_DIR/.certs/server-cert.pem" "$APP_DIR/.certs/ca-cert.pem" "$APP_DIR/.ca/ca-cert.pem"; do
            if [ -f "$cert" ]; then
                sudo chmod 644 "$cert"
            fi
        done
    }

    # 6. Check/generate certificates
    CERT_DIR="/opt/okproxy/certs"
    CA_DIR="/opt/okproxy/ca"
    if [ -f "$CERT_DIR/server-cert.pem" ]; then
        echo "Using uploaded certificates from $CERT_DIR"
        CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CERT_DIR/ca-cert.pem --ca-dir $CA_DIR"
    elif [ ! -f "$APP_DIR/.certs/server-cert.pem" ]; then
        echo "Generating certificates..."
        cd "$APP_DIR"
        "$NODE_PATH" apps/server/bin/tunnel-ca.js init
        "$NODE_PATH" apps/server/bin/tunnel-ca.js issue-server --hostname "$HOSTNAME" --output ./.certs
        # Client certificates should be issued separately with --domain for cert-bound deployments.
        echo "Certificates generated."
        CERT_OPTS="--ca-dir $APP_DIR/.ca"
    else
        echo "Using generated certificates from .certs/"
        CERT_OPTS="--ca-dir $APP_DIR/.ca"
    fi
    fix_cert_permissions

    SERVER_MODE_OPTS=""
    if [ "$CERT_BOUND_DOMAINS" = true ]; then
        SERVER_MODE_OPTS="--cert-bound-domains --http-host 127.0.0.1"
        if [ -f "$CA_DIR/issued-domains.json" ]; then
            SERVER_MODE_OPTS="$SERVER_MODE_OPTS --issued-domain-index $CA_DIR/issued-domains.json"
        elif [ -f "$APP_DIR/.ca/issued-domains.json" ]; then
            SERVER_MODE_OPTS="$SERVER_MODE_OPTS --issued-domain-index $APP_DIR/.ca/issued-domains.json"
        fi
    fi

    # 7. Setup systemd service
    echo "Setting up systemd service..."
    sudo tee /etc/systemd/system/okproxy.service > /dev/null <<EOF
[Unit]
Description=OKProxy Tunnel Server
After=network.target

[Service]
Type=simple
User=okproxy
Group=okproxy
WorkingDirectory=/opt/okproxy
ExecStart=$NODE_PATH apps/server/index.js --http-port 8080 --tls-port 9443 --max-body-size 230686720 $CERT_OPTS $SERVER_MODE_OPTS
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/okproxy/ca /opt/okproxy/certs /opt/okproxy/.ca /opt/okproxy/.certs
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictSUIDSGID=true
LockPersonality=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable okproxy
    sudo systemctl restart okproxy
    echo "Systemd service configured and started."

    # 8. Setup Caddyfile
    echo "Configuring Caddy for $HOSTNAME..."
    if [ "$CERT_BOUND_DOMAINS" = true ]; then
        sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
{
    on_demand_tls {
        ask http://127.0.0.1:8080/_okproxy/caddy-ask
    }
}

:80 {
    redir https://{host}{uri} permanent
}

:443 {
    tls {
        on_demand
    }
    request_body {
        max_size 231MB
    }
    reverse_proxy 127.0.0.1:8080
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
}
EOF
    else
        sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
$HOSTNAME {
    request_body {
        max_size 231MB
    }
    reverse_proxy 127.0.0.1:8080
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
}
EOF
    fi
    echo "Reloading Caddy..."
    sudo systemctl reload caddy

    # 9. SSH Hardening
    echo "Hardening SSH security..."
    if [ -f /etc/ssh/sshd_config ]; then
        sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
        sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
        sudo sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
        sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
        echo "Validating SSH config..."
        if sudo sshd -t; then
            echo "Restarting SSH service..."
            sudo systemctl restart ssh
        else
            echo "ERROR: SSH config is invalid. Restoring backup..."
            sudo cp /etc/ssh/sshd_config.bak /etc/ssh/sshd_config
        fi
    fi

    # 10. Install Fail2Ban
    echo "Installing Fail2Ban..."
    sudo apt install -y fail2ban
    sudo tee /etc/fail2ban/jail.local > /dev/null <<EOF
[DEFAULT]
bantime  = 24h
findtime = 10m
maxretry = 3

[sshd]
enabled = true
backend = systemd
EOF
    echo "Restarting Fail2Ban..."
    sudo systemctl restart fail2ban

    # 11. Configure Unattended Upgrades
    echo "Configuring Unattended Upgrades..."
    sudo apt install -y unattended-upgrades
    echo "unattended-upgrades unattended-upgrades/enable_auto_updates boolean true" | sudo debconf-set-selections
    sudo dpkg-reconfigure -f noninteractive unattended-upgrades

    # 12. Configure Firewall (UFW)
    echo "Configuring firewall..."
    sudo apt install -y ufw
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp    # SSH
    sudo ufw allow 80/tcp    # HTTP
    sudo ufw allow 443/tcp   # HTTPS
    sudo ufw allow 9443/tcp  # TLS tunnel
    sudo ufw --force enable

    # 13. Configure journal size cap
    echo "Configuring journal size limits..."
    if [ ! -f /etc/systemd/journald.conf.d/99-size-limits.conf ]; then
        sudo mkdir -p /etc/systemd/journald.conf.d
        sudo tee /etc/systemd/journald.conf.d/99-size-limits.conf > /dev/null <<EOF
[Journal]
SystemMaxUse=500M
MaxFileSec=1week
EOF
        sudo systemctl restart systemd-journald
        echo "Journal size limits configured."
    else
        echo "Journal size limits already configured."
    fi

    # 14. Final Permission Fix
    echo "Ensuring okproxy service can read application files and certificates..."
    sudo chown -R okproxy:okproxy "$APP_DIR"
    fix_cert_permissions

    # 15. Health Check
    echo ""
    echo "Running health checks..."
    
    # Check systemd service
    if systemctl is-active okproxy > /dev/null 2>&1; then
        echo "✓ okproxy service is active"
    else
        echo "✗ okproxy service is NOT active"
        echo "Service logs:"
        journalctl -u okproxy -n 20 --no-pager || true
        exit 1
    fi
    
    # Check HTTP endpoint (with 5s timeout to prevent hanging)
    HTTP_OK=false
    for i in 1 2 3; do
        if curl -sf --connect-timeout 5 --max-time 10 http://localhost:8080/ > /dev/null 2>&1 || curl -sf --connect-timeout 5 --max-time 10 http://localhost:8080/health > /dev/null 2>&1; then
            echo "✓ HTTP endpoint is responding"
            HTTP_OK=true
            break
        fi
        sleep 2
    done
    
    if [ "$HTTP_OK" = false ]; then
        echo "✗ HTTP endpoint is NOT responding"
    fi
    
    # Check TLS port
    if ss -tlnp | grep -q ':9443'; then
        echo "✓ TLS port 9443 is listening"
    else
        echo "✗ TLS port 9443 is NOT listening"
    fi

fi

echo ""
echo "Setup completed successfully!"
if [ "$DEV_MODE" = true ]; then
    echo "Dev environment is ready. Run 'npm start' in apps/server/ to start."
else
    echo "Production deployment complete!"
    echo "Service status: systemctl status okproxy"
    echo "View logs: journalctl -u okproxy -f"
fi

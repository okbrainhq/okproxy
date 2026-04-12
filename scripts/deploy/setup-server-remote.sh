#!/bin/bash

# setup-server-remote.sh
# Purpose: Installs dependencies and prepares the environment for tunzero on Debian.
# Usage:
#   Production: ./setup-server-remote.sh <HOSTNAME> <REPO_URL>
#   Dev:        ./setup-server-remote.sh --dev

set -eo pipefail

# Parse flags
DEV_MODE=false
for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE=true ;;
    esac
done

APP_DIR="/var/www/tunzero"

if [ "$DEV_MODE" = false ]; then
    # Collect positional args (skip flags)
    POSITIONAL=()
    for arg in "$@"; do
        case "$arg" in
            --*) ;; # skip flags
            *) POSITIONAL+=("$arg") ;;
        esac
    done
    if [ ${#POSITIONAL[@]} -lt 2 ]; then
        echo "Error: Hostname and repository URL are required."
        echo "Usage:"
        echo "  Production: ./remote-setup.sh <HOSTNAME> <REPO_URL>"
        echo "  Dev:        ./remote-setup.sh --dev"
        exit 1
    fi
    HOSTNAME="${POSITIONAL[0]}"
    REPO_URL="${POSITIONAL[1]}"
    echo "Starting setup for Tunzero (production)..."
    echo "Target Directory: $APP_DIR"
    echo "Repository: $REPO_URL"
    echo "Hostname: $HOSTNAME"
else
    echo "Starting setup for Tunzero (dev mode)..."
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
echo "Installing basic tools (curl, git, unzip, rsync)..."
sudo apt install -y curl git unzip rsync

# 3. Install Node.js (v20)
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "Node.js is already installed: $(node -v)"
fi

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
    CERT_DIR="/var/www/tunzero/certs"
    if [ -d "$APP_DIR/.git" ]; then
        echo "App directory exists. Updating repository..."
        cd "$APP_DIR"
        git fetch origin
        git reset --hard "origin/main"
        echo "Repository updated."
    else
        echo "App directory does not exist. Cloning repository..."
        if [ -d "$APP_DIR" ]; then
            sudo rm -rf "$APP_DIR"
        fi
        sudo mkdir -p "$(dirname "$APP_DIR")"
        sudo chown -R "$REAL_USER":"$REAL_USER" "$(dirname "$APP_DIR")"
        git clone "$REPO_URL" "$APP_DIR"
        echo "Repository cloned."
    fi

    # Ensure proper ownership
    sudo chown -R "$REAL_USER":"$REAL_USER" "$APP_DIR"

    # 6. Check/generate certificates
    CERT_DIR="/var/www/tunzero/certs"
    if [ -f "$CERT_DIR/server-cert.pem" ]; then
        echo "Using uploaded certificates from $CERT_DIR"
        CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CERT_DIR/ca-cert.pem"
    elif [ ! -f "$APP_DIR/.certs/server-cert.pem" ]; then
        echo "Generating certificates..."
        cd "$APP_DIR"
        node apps/server/bin/tunnel-ca.js init
        node apps/server/bin/tunnel-ca.js issue-server --hostname "$HOSTNAME" --output ./.certs
        node apps/server/bin/tunnel-ca.js issue-client
        echo "Certificates generated."
        CERT_OPTS=""
    else
        echo "Using generated certificates from .certs/"
        CERT_OPTS=""
    fi

    # 7. Setup systemd service
echo "Setting up systemd service..."
sudo tee /etc/systemd/system/tunzero.service > /dev/null <<EOF
[Unit]
Description=Tunzero Tunnel Server
After=network.target

[Service]
Type=simple
User=$REAL_USER
WorkingDirectory=/var/www/tunzero
ExecStart=/usr/bin/node apps/server/index.js --http-port 8080 --tls-port 9443 $CERT_OPTS
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable tunzero
    sudo systemctl restart tunzero
    echo "Systemd service configured and started."

    # 8. Setup Caddyfile
    echo "Configuring Caddy for $HOSTNAME..."
    sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
$HOSTNAME {
    reverse_proxy localhost:8080
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
}
EOF
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
    echo "Ensuring file ownership for $REAL_USER..."
    sudo chown -R "$REAL_USER":"$REAL_USER" "$APP_DIR"

    # 15. Health Check
    echo ""
    echo "Running health checks..."
    
    # Check systemd service
    if systemctl is-active tunzero > /dev/null 2>&1; then
        echo "✓ tunzero service is active"
    else
        echo "✗ tunzero service is NOT active"
        echo "Service logs:"
        journalctl -u tunzero -n 20 --no-pager || true
        exit 1
    fi
    
    # Check HTTP endpoint
    HTTP_OK=false
    for i in 1 2 3; do
        if curl -sf http://localhost:8080/ > /dev/null 2>&1 || curl -sf http://localhost:8080/health > /dev/null 2>&1; then
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
    echo "Service status: systemctl status tunzero"
    echo "View logs: journalctl -u tunzero -f"
fi

#!/bin/bash

# setup-client-remote-ubuntu.sh
# Purpose: Installs the tunnel client on Debian/Ubuntu and runs it as a systemd service.
# Usage: ./setup-client-remote-ubuntu.sh <SERVER_HOST> <TARGET_HOST> <REPO_URL> [CLIENT_NAME] [CERT_DIR] [PARALLEL_SOCKETS] [options]
# Example: ./setup-client-remote-ubuntu.sh t0.arunoda.me:9443 localhost:3000 https://github.com/arunoda/okproxy.git blog ~/.okproxy/certs/blog 4
#
# Options:
#   --app-dir <path>       Repo/app directory on this machine (default: $HOME/okproxy)
#   --branch <name>        Git branch to deploy (default: main)
#   --node-path <path>     Use this Node.js binary instead of auto-detecting one
#   --service-user <user>  Run the system service as this user (default: current user)
#   --system               Force a system-wide service (requires root/sudo)
#   --user                 Force a per-user service (systemctl --user)
#   --no-multipath         Run in single-connection mode instead of multipath
#   --no-start             Install the service without enabling/starting it
#   --help                 Show this help

set -eo pipefail

usage() {
    sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------- arguments
SERVER_HOST=""
TARGET_HOST=""
REPO_URL=""
CLIENT_NAME="default"
CERT_DIR=""
PARALLEL_SOCKETS="4"

APP_DIR="$HOME/okproxy"
BRANCH="main"
NODE_PATH_OVERRIDE=""
SERVICE_USER=""
SERVICE_SCOPE=""
MULTIPATH=true
START_SERVICE=true

POSITIONAL=()
while [ $# -gt 0 ]; do
    case "$1" in
        --app-dir) shift; APP_DIR="$1" ;;
        --branch) shift; BRANCH="$1" ;;
        --node-path) shift; NODE_PATH_OVERRIDE="$1" ;;
        --service-user) shift; SERVICE_USER="$1" ;;
        --system) SERVICE_SCOPE="system" ;;
        --user) SERVICE_SCOPE="user" ;;
        --no-multipath) MULTIPATH=false ;;
        --no-start) START_SERVICE=false ;;
        --help|-h) usage; exit 0 ;;
        --*) echo "Error: unknown option: $1"; usage; exit 1 ;;
        *) POSITIONAL+=("$1") ;;
    esac
    shift
done

if [ "${#POSITIONAL[@]}" -lt 3 ]; then
    echo "Error: SERVER_HOST, TARGET_HOST, and REPO_URL are required."
    usage
    exit 1
fi

SERVER_HOST="${POSITIONAL[0]}"
TARGET_HOST="${POSITIONAL[1]}"
REPO_URL="${POSITIONAL[2]}"
CLIENT_NAME="${POSITIONAL[3]:-default}"
CERT_DIR="${POSITIONAL[4]:-}"
PARALLEL_SOCKETS="${POSITIONAL[5]:-$PARALLEL_SOCKETS}"

# ------------------------------------------------------------ normalize input
SERVER_HOSTNAME="${SERVER_HOST%%:*}"
SERVER_PORT="${SERVER_HOST##*:}"
if [ "$SERVER_PORT" = "$SERVER_HOST" ]; then
    SERVER_PORT=9443
fi

TARGET_HOSTNAME="${TARGET_HOST%%:*}"
TARGET_PORT="${TARGET_HOST##*:}"
if [ "$TARGET_PORT" = "$TARGET_HOST" ]; then
    TARGET_PORT=3000
fi

SAFE_CLIENT_NAME=$(printf '%s' "$CLIENT_NAME" | tr -c 'A-Za-z0-9_.-' '-')
if [ -z "$SAFE_CLIENT_NAME" ]; then
    SAFE_CLIENT_NAME="default"
fi

# Expand a leading ~ (literal, shell-independent of pattern matching rules)
expand_home() {
    case "$1" in
        '~') printf '%s' "$HOME" ;;
        '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
        *) printf '%s' "$1" ;;
    esac
}

# Resolve the cert directory
if [ -z "$CERT_DIR" ]; then
    if [ "$SAFE_CLIENT_NAME" = "default" ]; then
        CERT_DIR="$HOME/.okproxy/certs"
    else
        CERT_DIR="$HOME/.okproxy/certs/$SAFE_CLIENT_NAME"
    fi
else
    CERT_DIR="$(expand_home "$CERT_DIR")"
fi
if [[ "$CERT_DIR" != /* ]]; then
    CERT_DIR="$(pwd)/$CERT_DIR"
fi

APP_DIR="$(expand_home "$APP_DIR")"
if [[ "$APP_DIR" != /* ]]; then
    APP_DIR="$(pwd)/$APP_DIR"
fi

if [ "$SAFE_CLIENT_NAME" = "default" ]; then
    LOG_DIR="$HOME/.okproxy/logs"
    SERVICE_NAME="okproxy-client"
else
    LOG_DIR="$HOME/.okproxy/logs/$SAFE_CLIENT_NAME"
    SERVICE_NAME="okproxy-client-$SAFE_CLIENT_NAME"
fi

CLIENT_DIR="$APP_DIR/apps/client"

if ! [[ "$PARALLEL_SOCKETS" =~ ^[0-9]+$ ]] || [ "$PARALLEL_SOCKETS" -lt 1 ] || [ "$PARALLEL_SOCKETS" -gt 32 ]; then
    echo "Error: PARALLEL_SOCKETS must be an integer from 1 to 32."
    exit 1
fi

if [ "$(uname -s)" != "Linux" ]; then
    echo "Error: this script targets Linux (Debian/Ubuntu systemd hosts). Detected: $(uname -s)"
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    echo "Error: systemctl not found. This host does not use systemd."
    exit 1
fi

for tool in git curl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Error: '$tool' is required but not installed."
        exit 1
    fi
done

# --------------------------------------------------------------- sudo/mode
SUDO=""
if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif sudo -n true 2>/dev/null; then
    SUDO="sudo"
fi

if [ -z "$SERVICE_SCOPE" ]; then
    if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
        SERVICE_SCOPE="system"
    else
        SERVICE_SCOPE="user"
    fi
fi

if [ "$SERVICE_SCOPE" = "system" ] && [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
    echo "Error: a system service requires root or passwordless sudo."
    echo "       Re-run with --user for a per-user service."
    exit 1
fi

if [ "$SERVICE_SCOPE" = "system" ]; then
    if [ -z "$SERVICE_USER" ]; then
        if [ "$(id -u)" -eq 0 ]; then
            SERVICE_USER="${SUDO_USER:-root}"
        else
            SERVICE_USER="$(id -un)"
        fi
    fi
    UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
else
    if [ -z "$SERVICE_USER" ]; then
        SERVICE_USER="$(id -un)"
    fi
    UNIT_PATH="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
fi

echo "Setting up OKProxy Client on Ubuntu..."
echo "Service: $SERVICE_NAME (${SERVICE_SCOPE} systemd unit, user: $SERVICE_USER)"
echo "App directory: $APP_DIR"
echo "Server: $SERVER_HOSTNAME:$SERVER_PORT"
echo "Target: $TARGET_HOSTNAME:$TARGET_PORT"
echo "Repository: $REPO_URL"
echo "Client name: $SAFE_CLIENT_NAME"
echo "Parallel sockets per interface: $PARALLEL_SOCKETS"
echo "Multipath: $MULTIPATH"
echo "Cert directory: $CERT_DIR"
echo "Log directory: $LOG_DIR"

# ------------------------------------------------------------------- Node.js
node_major() {
    "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

install_node() {
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64) NODE_ARCH="linux-x64" ;;
        aarch64|arm64) NODE_ARCH="linux-arm64" ;;
        armv7l) NODE_ARCH="linux-armv7l" ;;
        *) echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
    esac

    TARGET_NODE_VERSION="v22"
    LTS_DATA=$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null || echo "")
    if [ -n "$LTS_DATA" ]; then
        DETECTED=$(echo "$LTS_DATA" | tr '}' '\n' | grep '"lts":"' | head -1 | sed -E 's/.*"version":"(v[0-9]+)\..*/\1/' || true)
        if [ -n "$DETECTED" ]; then
            TARGET_NODE_VERSION="$DETECTED"
        fi
    fi
    echo "Installing Node.js ${TARGET_NODE_VERSION}.x (${NODE_ARCH}) to $HOME/.local..."

    NODE_VERSION_FULL=$(curl -fsSL "https://nodejs.org/dist/latest-${TARGET_NODE_VERSION}.x/" 2>/dev/null \
        | grep -oE "node-${TARGET_NODE_VERSION}\.[0-9]+\.[0-9]+-${NODE_ARCH}\.tar\.gz" | head -1 \
        | sed "s/node-//;s/-${NODE_ARCH}\.tar\.gz//") || true
    if [ -z "$NODE_VERSION_FULL" ]; then
        echo "Error: could not determine the latest Node.js ${TARGET_NODE_VERSION}.x release."
        exit 1
    fi

    NODE_TARBALL="node-${NODE_VERSION_FULL}-${NODE_ARCH}.tar.gz"
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION_FULL}/${NODE_TARBALL}" -o "$TEMP_DIR/$NODE_TARBALL"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION_FULL}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

    EXPECTED_HASH=$(grep " $NODE_TARBALL\$" "$TEMP_DIR/SHASUMS256.txt" | awk '{print $1}')
    ACTUAL_HASH=$(sha256sum "$TEMP_DIR/$NODE_TARBALL" | awk '{print $1}')
    if [ -z "$EXPECTED_HASH" ] || [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
        echo "Error: SHA256 checksum verification failed for $NODE_TARBALL"
        exit 1
    fi
    echo "SHA256 checksum verified."

    mkdir -p "$HOME/.local"
    tar -xz -C "$HOME/.local" --strip-components=1 -f "$TEMP_DIR/$NODE_TARBALL"
    if [ ! -x "$HOME/.local/bin/node" ]; then
        echo "Error: Node.js installation failed."
        exit 1
    fi
}

if [ -n "$NODE_PATH_OVERRIDE" ]; then
    if [ ! -x "$NODE_PATH_OVERRIDE" ]; then
        echo "Error: --node-path is not executable: $NODE_PATH_OVERRIDE"
        exit 1
    fi
    NODE_BIN="$NODE_PATH_OVERRIDE"
    echo "Using Node.js from --node-path: $NODE_BIN"
elif [ -n "$OKPROXY_NODE_PATH" ]; then
    if [ ! -x "$OKPROXY_NODE_PATH" ]; then
        echo "Error: OKPROXY_NODE_PATH is not executable: $OKPROXY_NODE_PATH"
        exit 1
    fi
    NODE_BIN="$OKPROXY_NODE_PATH"
    echo "Using Node.js from OKPROXY_NODE_PATH: $NODE_BIN"
else
    SYSTEM_NODE=""
    for candidate in /usr/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
        if [ -x "$candidate" ]; then
            SYSTEM_NODE="$candidate"
            break
        fi
    done
    if [ -n "$SYSTEM_NODE" ] && [ "$(node_major "$SYSTEM_NODE")" -ge 20 ]; then
        NODE_BIN="$SYSTEM_NODE"
    else
        if [ -n "$SYSTEM_NODE" ]; then
            echo "Found Node.js $("$SYSTEM_NODE" -v) at $SYSTEM_NODE; version 20+ is required."
        else
            echo "No Node.js found."
        fi
        install_node
        NODE_BIN="$HOME/.local/bin/node"
    fi
fi
echo "Using Node.js at: $NODE_BIN ($("$NODE_BIN" -v))"

# ---------------------------------------------------------------- directories
mkdir -p "$CERT_DIR" "$LOG_DIR"

# ----------------------------------------------------------------- repository
if [ -d "$APP_DIR/.git" ]; then
    echo "Updating repository in $APP_DIR..."
    git -C "$APP_DIR" fetch --quiet origin
    git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
    echo "Repository updated to origin/$BRANCH."
elif [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    echo "Error: $APP_DIR exists but is not a git repository."
    echo "       Remove it, or pass --app-dir with a different path."
    exit 1
else
    echo "Cloning repository into $APP_DIR..."
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    echo "Repository cloned (branch: $BRANCH)."
fi

if [ ! -f "$CLIENT_DIR/index.js" ]; then
    echo "Error: $CLIENT_DIR/index.js not found after checkout."
    exit 1
fi

# ------------------------------------------------------------------ certs
CLIENT_CERT="$CERT_DIR/client-cert.pem"
CLIENT_KEY="$CERT_DIR/client-key.pem"
CA_CERT="$CERT_DIR/ca-cert.pem"

for f in "$CLIENT_CERT" "$CLIENT_KEY" "$CA_CERT"; do
    if [ ! -f "$f" ]; then
        echo "Error: missing certificate file: $f"
        echo "Run setup-client.sh with --upload-certs, or copy client-cert.pem,"
        echo "client-key.pem and ca-cert.pem into $CERT_DIR manually."
        exit 1
    fi
done
chmod 600 "$CLIENT_KEY"
chmod 644 "$CLIENT_CERT" "$CA_CERT"
echo "Certificates verified at $CERT_DIR"

# ------------------------------------------------------------ systemd unit
if [ "$MULTIPATH" = true ]; then
    MULTIPATH_ARG="--multipath"
else
    MULTIPATH_ARG=""
fi

UNIT_TMP=$(mktemp)
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=okproxy tunnel client (${SAFE_CLIENT_NAME}) -> ${SERVER_HOSTNAME}:${SERVER_PORT}
Documentation=https://github.com/okbrainhq/okproxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${CLIENT_DIR}
ExecStart=${NODE_BIN} ${CLIENT_DIR}/index.js ${MULTIPATH_ARG} --server ${SERVER_HOSTNAME}:${SERVER_PORT} --target ${TARGET_HOSTNAME}:${TARGET_PORT} --parallel-sockets ${PARALLEL_SOCKETS} --cert ${CLIENT_CERT} --key ${CLIENT_KEY} --ca ${CA_CERT}
Restart=always
RestartSec=5
TimeoutStopSec=20
KillSignal=SIGTERM
StandardOutput=append:${LOG_DIR}/client.log
StandardError=append:${LOG_DIR}/client-error.log
Environment=NODE_ENV=production
Environment=OKPROXY_PARALLEL_SOCKETS=${PARALLEL_SOCKETS}
Environment=MULTIPATH_ENABLED=${MULTIPATH}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true

[Install]
WantedBy=$([ "$SERVICE_SCOPE" = "system" ] && echo "multi-user.target" || echo "default.target")
EOF

echo "Installing systemd unit at $UNIT_PATH..."
if [ "$SERVICE_SCOPE" = "system" ]; then
    $SUDO install -m 644 "$UNIT_TMP" "$UNIT_PATH"
    $SUDO systemctl daemon-reload
else
    mkdir -p "$(dirname "$UNIT_PATH")"
    install -m 644 "$UNIT_TMP" "$UNIT_PATH"
    systemctl --user daemon-reload
fi
rm -f "$UNIT_TMP"

# --------------------------------------------------------------- start/enable
ACTIVE=false
if [ "$START_SERVICE" = true ]; then
    echo "Enabling and starting ${SERVICE_NAME}..."
    if [ "$SERVICE_SCOPE" = "system" ]; then
        $SUDO systemctl enable --now "$SERVICE_NAME"
    else
        systemctl --user enable --now "$SERVICE_NAME"
        if command -v loginctl >/dev/null 2>&1; then
            $SUDO loginctl enable-linger "$SERVICE_USER" 2>/dev/null \
                || loginctl enable-linger "$SERVICE_USER" 2>/dev/null \
                || true
        fi
    fi
    sleep 3

    # Log files are created by systemd (root); hand them to the service user
    if [ "$SERVICE_SCOPE" = "system" ] && [ -n "$SUDO" ]; then
        $SUDO chown -R "$SERVICE_USER" "$LOG_DIR" 2>/dev/null || true
    fi

    if [ "$SERVICE_SCOPE" = "system" ]; then
        systemctl is-active --quiet "$SERVICE_NAME" && ACTIVE=true
    else
        systemctl --user is-active --quiet "$SERVICE_NAME" && ACTIVE=true
    fi

    if [ "$ACTIVE" = true ]; then
        echo "Service is active."
    else
        echo "Warning: service is not active yet. Recent log output:"
    fi
else
    echo "Skipping start (--no-start). Enable later with:"
    if [ "$SERVICE_SCOPE" = "system" ]; then
        echo "  sudo systemctl enable --now $SERVICE_NAME"
    else
        echo "  systemctl --user enable --now $SERVICE_NAME"
    fi
fi

# ------------------------------------------------------------- health check
LOG_FILE="$LOG_DIR/client.log"
CONNECTED=false
if [ "$START_SERVICE" = true ]; then
    echo "Waiting for the tunnel to connect (up to 30s)..."
    for _ in $(seq 1 30); do
        if [ -f "$LOG_FILE" ] && grep -q "Connected to TLS tunnel server" "$LOG_FILE"; then
            CONNECTED=true
            break
        fi
        sleep 1
    done
fi

echo ""
if [ -f "$LOG_FILE" ]; then
    echo "Recent client log ($LOG_FILE):"
    tail -n 10 "$LOG_FILE"
fi
if [ -s "$LOG_DIR/client-error.log" ]; then
    echo ""
    echo "Recent client error log ($LOG_DIR/client-error.log):"
    tail -n 10 "$LOG_DIR/client-error.log"
fi

echo ""
if [ "$START_SERVICE" = true ] && [ "$CONNECTED" != true ]; then
    echo "Setup finished, but no successful tunnel connection was logged yet."
    echo "The client retries automatically; check logs if it stays disconnected."
fi

echo "Setup completed."
echo ""
echo "Management commands:"
if [ "$SERVICE_SCOPE" = "system" ]; then
    echo "  Status:  systemctl status $SERVICE_NAME"
    echo "  Restart: sudo systemctl restart $SERVICE_NAME"
    echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
else
    echo "  Status:  systemctl --user status $SERVICE_NAME"
    echo "  Restart: systemctl --user restart $SERVICE_NAME"
    echo "  Stop:    systemctl --user stop $SERVICE_NAME"
fi
echo "  Logs:    tail -f $LOG_DIR/client.log"
echo "  Errors:  tail -f $LOG_DIR/client-error.log"
echo ""
echo "The service starts on boot and restarts automatically on failure."

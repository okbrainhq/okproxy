#!/bin/bash

# setup-client-remote.sh
# Purpose: Installs the tunnel client on macOS and configures it to run as a LaunchAgent.
# Usage: ./setup-client-remote.sh <SERVER_HOST> <TARGET_HOST> <REPO_URL>
# Example: ./setup-client-remote.sh t0.arunoda.me:9443 localhost:3000 https://github.com/arunoda/tunzero.git

set -eo pipefail

# Collect positional args
if [ $# -lt 3 ]; then
    echo "Error: SERVER_HOST, TARGET_HOST, and REPO_URL are required."
    echo "Usage: ./setup-client-remote.sh <SERVER_HOST> <TARGET_HOST> <REPO_URL>"
    exit 1
fi

SERVER_HOST="$1"
TARGET_HOST="$2"
REPO_URL="$3"

# Parse server host and port
SERVER_HOSTNAME="${SERVER_HOST%%:*}"
SERVER_PORT="${SERVER_HOST##*:}"
if [ "$SERVER_PORT" = "$SERVER_HOST" ]; then
    SERVER_PORT=9443
fi

# Parse target host and port
TARGET_HOSTNAME="${TARGET_HOST%%:*}"
TARGET_PORT="${TARGET_HOST##*:}"
if [ "$TARGET_PORT" = "$TARGET_HOST" ]; then
    TARGET_PORT=3000
fi

APP_DIR="$HOME/tunzero"
CLIENT_DIR="$APP_DIR/apps/client"
CERT_DIR="$HOME/.tunzero/certs"
LOG_DIR="$HOME/.tunzero/logs"
LAUNCH_LABEL="com.tunzero.client"
PLIST_PATH="$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist"

echo "Starting setup for Tunzero Client on macOS..."
echo "App Directory: $APP_DIR"
echo "Server: $SERVER_HOSTNAME:$SERVER_PORT"
echo "Target: $TARGET_HOSTNAME:$TARGET_PORT"
echo "Repository: $REPO_URL"

# 1. Check for and install Node.js if needed
echo "Checking for Node.js..."
NODE_PATH=$(which node 2>/dev/null || true)
LOCAL_NODE="$HOME/.local/bin/node"

if [ -x "$LOCAL_NODE" ]; then
    echo "Found local Node.js installation: $LOCAL_NODE"
    NODE_PATH="$LOCAL_NODE"
elif command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo "Node.js is already installed: $NODE_VERSION"
    NODE_PATH=$(which node)
else
    echo "Node.js not found. Installing Node.js locally (no sudo required)..."
    
    # Detect architecture
    ARCH=$(uname -m)
    case "$ARCH" in
        arm64)
            NODE_ARCH="darwin-arm64"
            ;;
        x86_64)
            NODE_ARCH="darwin-x64"
            ;;
        *)
            echo "Unsupported architecture: $ARCH"
            echo "Please install Node.js manually from https://nodejs.org"
            exit 1
            ;;
    esac
    
    NODE_VERSION="v24.14.1"
    NODE_TARBALL="node-${NODE_VERSION}-${NODE_ARCH}.tar.gz"
    NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
    
    echo "Downloading Node.js ${NODE_VERSION} for ${ARCH}..."
    mkdir -p "$HOME/.local"
    curl -fsSL "$NODE_URL" | tar -xz -C "$HOME/.local" --strip-components=1
    
    if [ -x "$LOCAL_NODE" ]; then
        NODE_PATH="$LOCAL_NODE"
        echo "Node.js installed successfully: $($NODE_PATH --version)"
        echo "Node location: $NODE_PATH"
    else
        echo "Error: Node.js installation failed"
        exit 1
    fi
fi

# 2. Create necessary directories
echo "Creating directories..."
mkdir -p "$CERT_DIR"
mkdir -p "$LOG_DIR"

# 3. Clone or update repository
echo "Setting up repository..."
if [ -d "$APP_DIR/.git" ]; then
    echo "App directory exists. Updating repository..."
    cd "$APP_DIR"
    git fetch origin
    git reset --hard "origin/main"
    echo "Repository updated."
else
    echo "App directory does not exist. Cloning repository..."
    if [ -d "$APP_DIR" ]; then
        rm -rf "$APP_DIR"
    fi
    git clone "$REPO_URL" "$APP_DIR"
    echo "Repository cloned."
fi

# 4. Check/generate certificates (if not uploaded)
CLIENT_CERT="$CERT_DIR/client-cert.pem"
CLIENT_KEY="$CERT_DIR/client-key.pem"
CA_CERT="$CERT_DIR/ca-cert.pem"

if [ ! -f "$CLIENT_CERT" ] || [ ! -f "$CLIENT_KEY" ]; then
    echo "Client certificates not found in $CERT_DIR"
    echo "Please run setup-client.sh with --upload-certs from your server machine"
    echo "Or manually copy the certificates to $CERT_DIR:"
    echo "  - client-cert.pem"
    echo "  - client-key.pem"
    echo "  - ca-cert.pem"
    exit 1
fi

if [ ! -f "$CA_CERT" ]; then
    echo "CA certificate not found in $CERT_DIR"
    echo "Please run setup-client.sh with --upload-certs from your server machine"
    exit 1
fi

echo "Certificates verified at $CERT_DIR"

# Ensure we have NODE_PATH set for the plist
if [ -z "$NODE_PATH" ]; then
    NODE_PATH=$(which node)
fi

# 5. Unload existing LaunchAgent if present
echo "Checking for existing LaunchAgent..."
if launchctl list "$LAUNCH_LABEL" &> /dev/null; then
    echo "Unloading existing LaunchAgent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Remove old plist if exists
if [ -f "$PLIST_PATH" ]; then
    rm "$PLIST_PATH"
fi

# 6. Create LaunchAgent plist
echo "Creating LaunchAgent plist..."
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_LABEL}</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${CLIENT_DIR}/index.js</string>
        <string>--server</string>
        <string>${SERVER_HOSTNAME}:${SERVER_PORT}</string>
        <string>--target</string>
        <string>${TARGET_HOSTNAME}:${TARGET_PORT}</string>
        <string>--cert</string>
        <string>${CLIENT_CERT}</string>
        <string>--key</string>
        <string>${CLIENT_KEY}</string>
        <string>--ca</string>
        <string>${CA_CERT}</string>
    </array>
    
    <key>WorkingDirectory</key>
    <string>${CLIENT_DIR}</string>
    
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/client.log</string>
    
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/client-error.log</string>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>ThrottleInterval</key>
    <integer>10</integer>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
EOF

# 7. Load and start the LaunchAgent
echo "Loading LaunchAgent..."
launchctl load "$PLIST_PATH"

# 8. Start the service
echo "Starting tunnel client..."
launchctl start "$LAUNCH_LABEL"

# 9. Wait a moment and check status
sleep 2

echo ""
echo "Running health checks..."

# Check if LaunchAgent is loaded
if launchctl list "$LAUNCH_LABEL" &> /dev/null; then
    echo "✓ LaunchAgent is loaded"
else
    echo "✗ LaunchAgent is NOT loaded"
    exit 1
fi

# Check if process is running
PID=$(launchctl list "$LAUNCH_LABEL" 2>/dev/null | grep '"PID"' | awk '{print $NF}' | tr -d ';')
if [ -n "$PID" ] && [ "$PID" -gt 0 ] 2>/dev/null; then
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "✓ Client process is running (PID: $PID)"
    else
        echo "⚠ Client process not found (PID: $PID may have exited)"
    fi
else
    echo "⚠ Client may not be running (checking logs...)"
fi

# Check recent logs
if [ -f "$LOG_DIR/client.log" ]; then
    echo ""
    echo "Recent log entries:"
    tail -n 5 "$LOG_DIR/client.log"
fi

if [ -f "$LOG_DIR/client-error.log" ]; then
    ERROR_LOG=$(cat "$LOG_DIR/client-error.log")
    if [ -n "$ERROR_LOG" ]; then
        echo ""
        echo "Error log entries:"
        cat "$LOG_DIR/client-error.log"
    fi
fi

echo ""
echo "Setup completed successfully!"
echo ""
echo "The tunnel client is configured to:"
echo "  - Connect to: $SERVER_HOSTNAME:$SERVER_PORT"
echo "  - Forward to: $TARGET_HOSTNAME:$TARGET_PORT"
echo ""
echo "Management commands:"
echo "  Check status: launchctl list $LAUNCH_LABEL"
echo "  Start:        launchctl start $LAUNCH_LABEL"
echo "  Stop:         launchctl stop $LAUNCH_LABEL"
echo "  View logs:    tail -f $LOG_DIR/client.log"
echo "  View errors:  tail -f $LOG_DIR/client-error.log"
echo ""
echo "The client will automatically start on login and restart on crashes."

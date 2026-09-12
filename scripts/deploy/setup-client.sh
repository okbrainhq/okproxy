#!/bin/bash

# setup-client.sh
# Purpose: Orchestrates the setup of a tunnel client on a remote machine (macOS or Linux/Ubuntu).
# Usage: ./scripts/deploy/setup-client.sh [USER@HOST] [--upload-certs] [--cert-dir <dir>] [--client-name <name>] [--local] [--platform <darwin|linux>]
# Optional .deploy.client: PARALLEL_SOCKETS=4 (default)
#
# macOS  -> LaunchAgent (com.okproxy.client[.<name>]) via setup-client-remote.sh
# Linux  -> systemd unit (okproxy-client[.<name>]) via setup-client-remote-ubuntu.sh
# --local -> run on this machine without SSH/SCP

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read config from .deploy.client file
if [ -f "$PROJECT_ROOT/.deploy.client" ]; then
    source "$PROJECT_ROOT/.deploy.client"
else
    echo "Error: .deploy.client file not found in project root."
    echo "Create one with SERVER_HOST and TARGET_HOST variables."
    exit 1
fi

# Validate required config
if [ -z "$SERVER_HOST" ]; then
    echo "Error: SERVER_HOST not set in .deploy.client"
    exit 1
fi

if [ -z "$TARGET_HOST" ]; then
    echo "Error: TARGET_HOST not set in .deploy.client"
    exit 1
fi

if [ -z "$REPO_URL" ]; then
    echo "Error: REPO_URL not set in .deploy.client"
    exit 1
fi

# Parse command line arguments
HOST=""
UPLOAD_CERTS=false
LOCAL=false
PLATFORM=""
CLIENT_NAME=${CLIENT_NAME:-default}
CLIENT_CERT_DIR=${CLIENT_CERT_DIR:-$PROJECT_ROOT/.certs}
REMOTE_CERT_DIR=${REMOTE_CERT_DIR:-}
PARALLEL_SOCKETS=${PARALLEL_SOCKETS:-4}

while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
        --upload-certs)
            UPLOAD_CERTS=true
            ;;
        --cert-dir)
            shift
            CLIENT_CERT_DIR="$1"
            ;;
        --client-name)
            shift
            CLIENT_NAME="$1"
            ;;
        --remote-cert-dir)
            shift
            REMOTE_CERT_DIR="$1"
            ;;
        --local)
            LOCAL=true
            ;;
        --platform)
            shift
            PLATFORM="$1"
            ;;
        --*)
            # Unknown flag
            ;;
        *)
            # Assume it's the host
            HOST="$arg"
            ;;
    esac
    shift
done

# Resolve relative local cert directories from the project root
if [[ "$CLIENT_CERT_DIR" != /* ]]; then
    CLIENT_CERT_DIR="$PROJECT_ROOT/${CLIENT_CERT_DIR#./}"
fi

if [ "$LOCAL" = true ] && [ -n "$HOST" ]; then
    echo "Error: --local and a remote host cannot be combined."
    exit 1
fi

# If no local run and no host provided, check if DEPLOY_HOST is set in .deploy.client
if [ "$LOCAL" != true ] && [ -z "$HOST" ] && [ -n "$DEPLOY_HOST" ]; then
    HOST="$DEPLOY_HOST"
fi

if [ "$LOCAL" != true ] && [ -z "$HOST" ]; then
    echo "Error: No host specified and DEPLOY_HOST not set in .deploy.client file."
    echo "Usage: ./scripts/deploy/setup-client.sh [USER@HOST] [--upload-certs] [--cert-dir <dir>] [--client-name <name>] [--local] [--platform <darwin|linux>]"
    echo "Or set DEPLOY_HOST in .deploy.client file."
    exit 1
fi

if ! [[ "$PARALLEL_SOCKETS" =~ ^[0-9]+$ ]] || [ "$PARALLEL_SOCKETS" -lt 1 ] || [ "$PARALLEL_SOCKETS" -gt 32 ]; then
    echo "Error: PARALLEL_SOCKETS must be an integer from 1 to 32."
    exit 1
fi

# Build SSH/SCP port options
SSH_OPTS=""
SCP_OPTS=""
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    SSH_OPTS="-p $SSH_PORT"
    SCP_OPTS="-P $SSH_PORT"
fi

# 0. Determine the target platform and pick the matching remote setup script
if [ -z "$PLATFORM" ]; then
    if [ "$LOCAL" = true ]; then
        REMOTE_UNAME=$(uname -s)
    else
        REMOTE_UNAME=$(ssh $SSH_OPTS "$HOST" "uname -s" 2>/dev/null || true)
    fi

    case "$REMOTE_UNAME" in
        Darwin) PLATFORM="darwin" ;;
        Linux)  PLATFORM="linux" ;;
        "")
            echo "Error: could not detect the platform on ${HOST:-this machine}."
            echo "Pass --platform darwin or --platform linux explicitly."
            exit 1
            ;;
        *)
            echo "Error: unsupported platform '$REMOTE_UNAME'."
            echo "Pass --platform darwin or --platform linux explicitly."
            exit 1
            ;;
    esac
fi

case "$PLATFORM" in
    darwin|macos|mac)
        PLATFORM="darwin"
        REMOTE_SCRIPT="setup-client-remote.sh"
        PLATFORM_LABEL="macOS LaunchAgent"
        ;;
    linux|ubuntu|debian)
        PLATFORM="linux"
        REMOTE_SCRIPT="setup-client-remote-ubuntu.sh"
        PLATFORM_LABEL="systemd service"
        ;;
    *)
        echo "Error: unsupported --platform '$PLATFORM' (use darwin or linux)."
        exit 1
        ;;
esac

echo "Setting up OKProxy Client on ${HOST:-this machine ($(hostname))}..."
echo "Platform: ${PLATFORM} (${PLATFORM_LABEL})"
echo "Server: $SERVER_HOST"
echo "Target: $TARGET_HOST"
echo "Repository: $REPO_URL"
echo "Client name: $CLIENT_NAME"
echo "Parallel sockets per interface: $PARALLEL_SOCKETS"
echo "Local cert dir: $CLIENT_CERT_DIR"

if [ -n "$SSH_OPTS" ] && [ "$LOCAL" != true ]; then
    echo "Using custom SSH port: $SSH_PORT"
fi

# 1. Copy the platform setup script to the remote machine (skipped for --local)
if [ "$LOCAL" != true ]; then
    echo "Copying $REMOTE_SCRIPT..."
    scp $SCP_OPTS "$SCRIPT_DIR/$REMOTE_SCRIPT" "$HOST:~/$(basename "$REMOTE_SCRIPT")"
fi

# 2. Resolve the remote cert directory
if [ -z "$REMOTE_CERT_DIR" ]; then
    if [ "$CLIENT_NAME" = "default" ]; then
        REMOTE_CERT_DIR="~/.okproxy/certs"
    else
        REMOTE_CERT_DIR="~/.okproxy/certs/$CLIENT_NAME"
    fi
fi

# 3. Upload certificates if requested
if [ "$UPLOAD_CERTS" = true ]; then
    echo "Validating and uploading certificates..."

    if [ ! -d "$CLIENT_CERT_DIR" ]; then
        echo "Error: client cert directory not found: $CLIENT_CERT_DIR"
        echo "Generate certificates first: npx ca init"
        exit 1
    fi

    if [ ! -f "$CLIENT_CERT_DIR/client-cert.pem" ] || [ ! -f "$CLIENT_CERT_DIR/client-key.pem" ]; then
        echo "Error: Client certificates not found in $CLIENT_CERT_DIR"
        echo "Required files: client-cert.pem, client-key.pem"
        echo "Generate with: npx ca issue-client --domain <domain> --output <dir>"
        exit 1
    fi

    if [ ! -f "$CLIENT_CERT_DIR/ca-cert.pem" ]; then
        echo "Error: ca-cert.pem not found in $CLIENT_CERT_DIR"
        echo "It is shipped alongside client-cert.pem when the client cert is issued."
        exit 1
    fi

    echo "Local certificates validated."

    if [ "$LOCAL" = true ]; then
        LOCAL_CERT_DIR="${REMOTE_CERT_DIR/#\~/$HOME}"
        if [ "$(cd "$LOCAL_CERT_DIR" 2>/dev/null && pwd || echo "")" != "$(cd "$CLIENT_CERT_DIR" && pwd)" ]; then
            echo "Copying certificates to $LOCAL_CERT_DIR..."
            mkdir -p "$LOCAL_CERT_DIR"
            cp "$CLIENT_CERT_DIR/client-cert.pem" "$CLIENT_CERT_DIR/client-key.pem" "$CLIENT_CERT_DIR/ca-cert.pem" "$LOCAL_CERT_DIR/"
        else
            echo "Certificates are already in place at $LOCAL_CERT_DIR."
        fi
        chmod 600 "$LOCAL_CERT_DIR/client-key.pem"
        chmod 644 "$LOCAL_CERT_DIR/client-cert.pem" "$LOCAL_CERT_DIR/ca-cert.pem"
    else
        echo "Uploading certificates to remote machine..."
        ssh $SSH_OPTS "$HOST" "mkdir -p $REMOTE_CERT_DIR"
        scp $SCP_OPTS "$CLIENT_CERT_DIR/client-cert.pem" "$HOST:$REMOTE_CERT_DIR/"
        scp $SCP_OPTS "$CLIENT_CERT_DIR/client-key.pem" "$HOST:$REMOTE_CERT_DIR/"
        scp $SCP_OPTS "$CLIENT_CERT_DIR/ca-cert.pem" "$HOST:$REMOTE_CERT_DIR/"
        ssh $SSH_OPTS "$HOST" "chmod 600 $REMOTE_CERT_DIR/client-key.pem && chmod 644 $REMOTE_CERT_DIR/client-cert.pem $REMOTE_CERT_DIR/ca-cert.pem"
        echo "Certificates uploaded successfully to $REMOTE_CERT_DIR"
    fi
fi

# 4. Execute the platform setup script
echo "Executing setup script on ${HOST:-this machine}..."
# Use printf %q to properly escape arguments to prevent shell injection
ESCAPED_SERVER_HOST=$(printf '%q' "$SERVER_HOST")
ESCAPED_TARGET_HOST=$(printf '%q' "$TARGET_HOST")
ESCAPED_REPO_URL=$(printf '%q' "$REPO_URL")
ESCAPED_CLIENT_NAME=$(printf '%q' "$CLIENT_NAME")
ESCAPED_REMOTE_CERT_DIR=$(printf '%q' "$REMOTE_CERT_DIR")
ESCAPED_PARALLEL_SOCKETS=$(printf '%q' "$PARALLEL_SOCKETS")

if [ "$LOCAL" = true ]; then
    chmod +x "$SCRIPT_DIR/$REMOTE_SCRIPT"
    "$SCRIPT_DIR/$REMOTE_SCRIPT" "$SERVER_HOST" "$TARGET_HOST" "$REPO_URL" "$CLIENT_NAME" "$REMOTE_CERT_DIR" "$PARALLEL_SOCKETS"
else
    ssh $SSH_OPTS "$HOST" "chmod +x ~/$(basename "$REMOTE_SCRIPT") && ~/$(basename "$REMOTE_SCRIPT") $ESCAPED_SERVER_HOST $ESCAPED_TARGET_HOST $ESCAPED_REPO_URL $ESCAPED_CLIENT_NAME $ESCAPED_REMOTE_CERT_DIR $ESCAPED_PARALLEL_SOCKETS"
fi

# 5. Print the platform-specific management commands
if [ "$PLATFORM" = "darwin" ]; then
    if [ "$CLIENT_NAME" = "default" ]; then
        LAUNCH_LABEL="com.okproxy.client"
        CLIENT_LOG_PATH="~/.okproxy/logs/client.log"
    else
        LAUNCH_LABEL="com.okproxy.client.$CLIENT_NAME"
        CLIENT_LOG_PATH="~/.okproxy/logs/$CLIENT_NAME/client.log"
    fi

    echo ""
    echo "Client setup completed successfully on ${HOST:-this machine}!"
    echo "The tunnel client will start automatically on login and restart on crashes."
    echo ""
    if [ "$LOCAL" = true ]; then
        echo "To check status: launchctl list $LAUNCH_LABEL"
        echo "To view logs: tail -f $CLIENT_LOG_PATH"
    elif [ -n "$SSH_OPTS" ]; then
        echo "To check status: ssh $SSH_OPTS $HOST 'launchctl list $LAUNCH_LABEL'"
        echo "To view logs: ssh $SSH_OPTS $HOST 'tail -f $CLIENT_LOG_PATH'"
    else
        echo "To check status: ssh $HOST 'launchctl list $LAUNCH_LABEL'"
        echo "To view logs: ssh $HOST 'tail -f $CLIENT_LOG_PATH'"
    fi
else
    if [ "$CLIENT_NAME" = "default" ]; then
        SERVICE_NAME="okproxy-client"
        CLIENT_LOG_PATH="~/.okproxy/logs/client.log"
    else
        SERVICE_NAME="okproxy-client-$CLIENT_NAME"
        CLIENT_LOG_PATH="~/.okproxy/logs/$CLIENT_NAME/client.log"
    fi

    echo ""
    echo "Client setup completed successfully on ${HOST:-this machine}!"
    echo "The tunnel client runs as the systemd unit ${SERVICE_NAME} (enabled at boot)."
    echo ""
    if [ "$LOCAL" = true ]; then
        echo "To check status: systemctl status $SERVICE_NAME"
        echo "To restart:     sudo systemctl restart $SERVICE_NAME"
        echo "To view logs:   tail -f $CLIENT_LOG_PATH"
    elif [ -n "$SSH_OPTS" ]; then
        echo "To check status: ssh $SSH_OPTS $HOST 'systemctl status $SERVICE_NAME'"
        echo "To view logs: ssh $SSH_OPTS $HOST 'tail -f $CLIENT_LOG_PATH'"
    else
        echo "To check status: ssh $HOST 'systemctl status $SERVICE_NAME'"
        echo "To view logs: ssh $HOST 'tail -f $CLIENT_LOG_PATH'"
    fi
fi

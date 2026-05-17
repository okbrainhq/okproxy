#!/bin/bash

# setup-client.sh
# Purpose: Orchestrates the setup of a tunnel client on a remote MacBook.
# Usage: ./scripts/deploy/setup-client.sh [USER@HOST] [--upload-certs]

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

for arg in "$@"; do
    case "$arg" in
        --upload-certs)
            UPLOAD_CERTS=true
            ;;
        --*)
            # Unknown flag
            ;;
        *)
            # Assume it's the host
            HOST="$arg"
            ;;
    esac
done

# If no host provided, check if DEPLOY_HOST is set in .deploy.client
if [ -z "$HOST" ] && [ -n "$DEPLOY_HOST" ]; then
    HOST="$DEPLOY_HOST"
fi

if [ -z "$HOST" ]; then
    echo "Error: No host specified and DEPLOY_HOST not set in .deploy.client file."
    echo "Usage: ./scripts/deploy/setup-client.sh [USER@HOST] [--upload-certs]"
    echo "Or set DEPLOY_HOST in .deploy.client file."
    exit 1
fi

echo "Setting up OKProxy Client on $HOST..."
echo "Server: $SERVER_HOST"
echo "Target: $TARGET_HOST"
echo "Repository: $REPO_URL"

# Build SSH/SCP port options
SSH_OPTS=""
SCP_OPTS=""
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    SSH_OPTS="-p $SSH_PORT"
    SCP_OPTS="-P $SSH_PORT"
    echo "Using custom SSH port: $SSH_PORT"
fi

# 1. Copy setup script to remote MacBook
echo "Copying setup-client-remote.sh..."
scp $SCP_OPTS "$SCRIPT_DIR/setup-client-remote.sh" "$HOST:~/setup-client-remote.sh"

# 2. Upload certificates if requested
# Note: Using ~ for remote home directory (will be expanded on remote side)
REMOTE_CERT_DIR="~/.okproxy/certs"
if [ "$UPLOAD_CERTS" = true ]; then
    echo "Validating and uploading certificates..."
    
    # Check local cert directories exist
    if [ ! -d "$PROJECT_ROOT/.certs" ]; then
        echo "Error: .certs directory not found in project root"
        echo "Generate certificates first: npx ca init"
        exit 1
    fi
    if [ ! -d "$PROJECT_ROOT/.ca" ]; then
        echo "Error: .ca directory not found in project root"
        echo "Generate certificates first: npx ca init"
        exit 1
    fi

    # Check required client certificate files exist
    if [ ! -f "$PROJECT_ROOT/.certs/client-cert.pem" ] || [ ! -f "$PROJECT_ROOT/.certs/client-key.pem" ]; then
        echo "Error: Client certificates not found in .certs/"
        echo "Required files: client-cert.pem, client-key.pem"
        echo "Generate with: npx ca issue-client"
        exit 1
    fi

    # Check CA certificate exists
    if [ ! -f "$PROJECT_ROOT/.ca/ca-cert.pem" ]; then
        echo "Error: CA certificate not found in .ca/"
        echo "Required file: ca-cert.pem"
        echo "Generate with: npx ca init"
        exit 1
    fi
    
    echo "Local certificates validated."
    echo "Uploading certificates to remote MacBook..."
    
    # Create remote cert directory (use ~ for remote expansion)
    ssh $SSH_OPTS "$HOST" "mkdir -p ~/.okproxy/certs"
    
    # Upload certificates using scp
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/client-cert.pem" "$HOST:~/.okproxy/certs/"
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/client-key.pem" "$HOST:~/.okproxy/certs/"
    scp $SCP_OPTS "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:~/.okproxy/certs/"
    
    # Fix permissions (private key should be restricted)
    ssh $SSH_OPTS "$HOST" "chmod 600 ~/.okproxy/certs/client-key.pem && chmod 644 ~/.okproxy/certs/client-cert.pem ~/.okproxy/certs/ca-cert.pem"
    
    echo "Certificates uploaded successfully to ~/.okproxy/certs/"
fi

# 3. Execute setup script remotely
echo "Executing setup script on remote MacBook..."
# Use printf %q to properly escape arguments to prevent shell injection
ESCAPED_SERVER_HOST=$(printf '%q' "$SERVER_HOST")
ESCAPED_TARGET_HOST=$(printf '%q' "$TARGET_HOST")
ESCAPED_REPO_URL=$(printf '%q' "$REPO_URL")
ssh $SSH_OPTS "$HOST" "chmod +x ~/setup-client-remote.sh && ~/setup-client-remote.sh $ESCAPED_SERVER_HOST $ESCAPED_TARGET_HOST $ESCAPED_REPO_URL"

echo ""
echo "Client setup completed successfully on $HOST!"
echo "The tunnel client will start automatically on login and restart on crashes."
echo ""
if [ -n "$SSH_OPTS" ]; then
    echo "To check status: ssh $SSH_OPTS $HOST 'launchctl list com.okproxy.client'"
    echo "To view logs: ssh $SSH_OPTS $HOST 'tail -f ~/.okproxy/logs/client.log'"
else
    echo "To check status: ssh $HOST 'launchctl list com.okproxy.client'"
    echo "To view logs: ssh $HOST 'tail -f ~/.okproxy/logs/client.log'"
fi

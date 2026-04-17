#!/bin/bash

# setup-server.sh
# Purpose: Orchestrates the setup on a remote server by copying scripts and running them.
# Usage: ./scripts/deploy/setup-server.sh [USER@HOST] [--upload-certs]

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read config from .deploy.server file
if [ -f "$PROJECT_ROOT/.deploy.server" ]; then
    source "$PROJECT_ROOT/.deploy.server"
else
    echo "Error: .deploy.server file not found in project root."
    echo "Create one with HOSTNAME and REPO_URL variables."
    exit 1
fi

# Validate required config
if [ -z "$HOSTNAME" ]; then
    echo "Error: HOSTNAME not set in .deploy.server"
    exit 1
fi

if [ -z "$REPO_URL" ]; then
    echo "Error: REPO_URL not set in .deploy.server"
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
        --dev)
            echo "Error: --dev flag should be used with setup-server-remote.sh directly, not setup-server.sh"
            exit 1
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

# If no host provided, check if DEPLOY_HOST is set in .deploy.server
if [ -z "$HOST" ] && [ -n "$DEPLOY_HOST" ]; then
    HOST="$DEPLOY_HOST"
fi

if [ -z "$HOST" ]; then
    echo "Error: No host specified and DEPLOY_HOST not set in .deploy.server file."
    echo "Usage: ./scripts/deploy/setup-server.sh [USER@HOST] [--upload-certs]"
    echo "Or set DEPLOY_HOST in .deploy.server file."
    exit 1
fi

echo "Setting up Tunzero on $HOST..."
echo "Hostname: $HOSTNAME"
echo "Repository: $REPO_URL"

# 1. Copy setup script to remote server
echo "Copying setup-server-remote.sh..."
scp "$SCRIPT_DIR/setup-server-remote.sh" "$HOST:~/setup-server-remote.sh"

# 2. Upload certificates if requested (do this FIRST so they exist when service starts)
CERT_DIR="/opt/tunzero/certs"
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

    # Check required server certificate files exist
    if [ ! -f "$PROJECT_ROOT/.certs/server-cert.pem" ] || [ ! -f "$PROJECT_ROOT/.certs/server-key.pem" ]; then
        echo "Error: Server certificates not found in .certs/"
        echo "Required files: server-cert.pem, server-key.pem"
        echo "Generate with: npx ca issue-server --hostname <hostname> --output ./.certs"
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
    echo "Uploading certificates to remote server..."
    
    # Create remote cert directory with secure permissions FIRST
    ssh "$HOST" "sudo mkdir -p $CERT_DIR && sudo chown -R \$USER:\$USER /opt/tunzero && sudo chmod 700 $CERT_DIR"

    # Upload certificates using scp
    scp "$PROJECT_ROOT/.certs/server-cert.pem" "$HOST:$CERT_DIR/"
    scp "$PROJECT_ROOT/.certs/server-key.pem" "$HOST:$CERT_DIR/"
    scp "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:$CERT_DIR/"

    # Fix ownership and permissions (directory already restricted, just fix files)
    echo "Fixing certificate ownership and permissions..."
    ssh "$HOST" "sudo chown -R \"\$SUDO_USER:\$SUDO_USER\" $CERT_DIR 2>/dev/null || sudo chown -R \"\$USER:\$USER\" $CERT_DIR"
    ssh "$HOST" "sudo chmod 600 $CERT_DIR/server-key.pem && sudo chmod 644 $CERT_DIR/server-cert.pem $CERT_DIR/ca-cert.pem"

    echo "Certificates uploaded successfully to $CERT_DIR"
fi

# 3. Execute setup script remotely (this handles git clone/update and service start)
echo "Executing setup script on remote host..."
# Use printf %q to properly escape arguments to prevent shell injection
ESCAPED_HOSTNAME=$(printf '%q' "$HOSTNAME")
ESCAPED_REPO_URL=$(printf '%q' "$REPO_URL")
ssh "$HOST" "chmod +x ~/setup-server-remote.sh && sudo ~/setup-server-remote.sh $ESCAPED_HOSTNAME $ESCAPED_REPO_URL"

echo "Remote setup completed successfully!"

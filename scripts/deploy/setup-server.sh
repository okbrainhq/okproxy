#!/bin/bash

# setup-server.sh
# Purpose: Orchestrates the setup on a remote server by copying scripts and running them.
# Usage: ./scripts/deploy/setup-server.sh [USER@HOST] [--upload-certs] [--classic] [--branch BRANCH]

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
CERT_BOUND_DOMAINS=${CERT_BOUND_DOMAINS:-true}
BRANCH=${BRANCH:-main}

while [ $# -gt 0 ]; do
    case "$1" in
        --upload-certs)
            UPLOAD_CERTS=true
            shift
            ;;
        --classic)
            CERT_BOUND_DOMAINS=false
            shift
            ;;
        --cert-bound-domains)
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
        --dev)
            echo "Error: --dev flag should be used with setup-server-remote.sh directly, not setup-server.sh"
            exit 1
            ;;
        --*)
            # Unknown flag
            shift
            ;;
        *)
            # Assume it's the host
            HOST="$1"
            shift
            ;;
    esac
done

if [ -z "$BRANCH" ]; then
    echo "Error: BRANCH cannot be empty. Set BRANCH in .deploy.server or pass --branch."
    exit 1
fi

# If no host provided, check if DEPLOY_HOST is set in .deploy.server
if [ -z "$HOST" ] && [ -n "$DEPLOY_HOST" ]; then
    HOST="$DEPLOY_HOST"
fi

if [ -z "$HOST" ]; then
    echo "Error: No host specified and DEPLOY_HOST not set in .deploy.server file."
    echo "Usage: ./scripts/deploy/setup-server.sh [USER@HOST] [--upload-certs] [--classic] [--branch BRANCH]"
    echo "Or set DEPLOY_HOST in .deploy.server file."
    exit 1
fi

echo "Setting up OKProxy on $HOST..."
echo "Hostname: $HOSTNAME"
echo "Repository: $REPO_URL"
echo "Branch: $BRANCH"
echo "Cert-bound domains: $CERT_BOUND_DOMAINS"

# Build SSH/SCP port options
SSH_OPTS=""
SCP_OPTS=""
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    SSH_OPTS="-p $SSH_PORT"
    SCP_OPTS="-P $SSH_PORT"
    echo "Using custom SSH port: $SSH_PORT"
fi

# 1. Copy setup script to remote server
echo "Copying setup-server-remote.sh..."
scp $SCP_OPTS "$SCRIPT_DIR/setup-server-remote.sh" "$HOST:~/setup-server-remote.sh"

# 2. Upload certificates if requested (do this FIRST so they exist when service starts)
CERT_DIR="/opt/okproxy/certs"
CA_DIR="/opt/okproxy/ca"
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
    ssh $SSH_OPTS "$HOST" "sudo mkdir -p $CERT_DIR $CA_DIR && sudo chown -R \$USER:\$USER /opt/okproxy && sudo chmod 700 $CERT_DIR $CA_DIR"

    # Upload certificates using scp
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/server-cert.pem" "$HOST:$CERT_DIR/"
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/server-key.pem" "$HOST:$CERT_DIR/"
    scp $SCP_OPTS "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:$CERT_DIR/"
    scp $SCP_OPTS "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:$CA_DIR/"
    if [ -f "$PROJECT_ROOT/.ca/issued-domains.json" ]; then
        scp $SCP_OPTS "$PROJECT_ROOT/.ca/issued-domains.json" "$HOST:$CA_DIR/"
    fi
    if [ -f "$PROJECT_ROOT/.ca/crl.txt" ]; then
        scp $SCP_OPTS "$PROJECT_ROOT/.ca/crl.txt" "$HOST:$CA_DIR/"
    fi

    # Fix ownership and permissions (directory already restricted, just fix files)
    echo "Fixing certificate ownership and permissions..."
    ssh $SSH_OPTS "$HOST" "sudo chown -R \"\$SUDO_USER:\$SUDO_USER\" $CERT_DIR $CA_DIR 2>/dev/null || sudo chown -R \"\$USER:\$USER\" $CERT_DIR $CA_DIR"
    ssh $SSH_OPTS "$HOST" "sudo chmod 600 $CERT_DIR/server-key.pem && sudo chmod 644 $CERT_DIR/server-cert.pem $CERT_DIR/ca-cert.pem && sudo chmod -R go-rwx $CA_DIR"

    echo "Certificates uploaded successfully to $CERT_DIR"
fi

# 3. Execute setup script remotely (this handles git clone/update and service start)
echo "Executing setup script on remote host..."
# Use printf %q to properly escape arguments to prevent shell injection
ESCAPED_HOSTNAME=$(printf '%q' "$HOSTNAME")
ESCAPED_REPO_URL=$(printf '%q' "$REPO_URL")
ESCAPED_BRANCH=$(printf '%q' "$BRANCH")
ESCAPED_CERT_BOUND_DOMAINS=$(printf '%q' "$CERT_BOUND_DOMAINS")
ssh $SSH_OPTS "$HOST" "chmod +x ~/setup-server-remote.sh && sudo ~/setup-server-remote.sh $ESCAPED_HOSTNAME $ESCAPED_REPO_URL --branch=$ESCAPED_BRANCH --cert-bound-domains=$ESCAPED_CERT_BOUND_DOMAINS"

echo "Remote setup completed successfully!"

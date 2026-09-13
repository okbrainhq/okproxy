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

if [ -n "$SSH_PORT" ]; then
    if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || [ "$SSH_PORT" -lt 1 ] || [ "$SSH_PORT" -gt 65535 ]; then
        echo "Error: SSH_PORT must be a port number between 1 and 65535 (got: $SSH_PORT)"
        exit 1
    fi
fi

if [ "$CERT_BOUND_DOMAINS" != true ] && [ "$CERT_BOUND_DOMAINS" != false ]; then
    echo "Error: CERT_BOUND_DOMAINS must be true or false (got: $CERT_BOUND_DOMAINS)"
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
# Trust material is stored outside the replaceable git checkout so a first-time
# clone/update can never delete uploaded keys or the CA.
#
# The active trust set is referenced through one symlink
# ($DATA_DIR/current -> releases/<id>). Uploads are staged in $DATA_DIR/staging,
# which is never the active directory: the complete set is validated on the
# server (key matches cert, cert chains to the CA) and promoted to a persistent
# release, and only then activated by swapping that single symlink with one
# atomic rename. An interrupted upload therefore cannot leave a new certificate
# next to an old key, and the previously active release stays intact and
# recoverable (see docs/deployment-fixes.md).
DATA_DIR="/var/lib/okproxy"
TRUST_ACTIVE_LINK="$DATA_DIR/current"
RELEASES_DIR="$DATA_DIR/releases"
STAGING_DIR="$DATA_DIR/staging"
DEPLOY_TRUST_ARG=""
if [ "$UPLOAD_CERTS" = true ]; then
    echo "Validating and staging certificates..."
    
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

    # Upload never activates. The setup transaction captures old trust (including
    # bootstrapped legacy paths) before code or active material is changed.
    RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    STAGED_RELEASE="$STAGING_DIR/$RELEASE_ID"
    echo "Staging trust release $RELEASE_ID in $STAGED_RELEASE (active material untouched)..."
    ssh $SSH_OPTS "$HOST" "sudo mkdir -p '$STAGED_RELEASE/certs' '$STAGED_RELEASE/ca' && sudo chown -R \"\$(id -un)\" '$STAGED_RELEASE'"

    # Upload every file into the staging directory. The active certs/ca
    # directories are never written to directly.
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/server-cert.pem" "$HOST:$STAGED_RELEASE/certs/"
    scp $SCP_OPTS "$PROJECT_ROOT/.certs/server-key.pem" "$HOST:$STAGED_RELEASE/certs/"
    scp $SCP_OPTS "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:$STAGED_RELEASE/certs/"
    scp $SCP_OPTS "$PROJECT_ROOT/.ca/ca-cert.pem" "$HOST:$STAGED_RELEASE/ca/"
    if [ -f "$PROJECT_ROOT/.ca/issued-domains.json" ]; then
        scp $SCP_OPTS "$PROJECT_ROOT/.ca/issued-domains.json" "$HOST:$STAGED_RELEASE/ca/"
    fi
    if [ -f "$PROJECT_ROOT/.ca/crl.txt" ]; then
        scp $SCP_OPTS "$PROJECT_ROOT/.ca/crl.txt" "$HOST:$STAGED_RELEASE/ca/"
    fi

    # Validate the complete staged set on the server. Nothing is activated
    # unless key, certificate and CA are present and coherent.
    echo "Validating the staged trust release on the server (active material untouched)..."
    if ! ssh $SSH_OPTS "$HOST" "sudo ~/setup-server-remote.sh --trust-release-validate='$RELEASE_ID'"; then
        echo "Error: the uploaded trust material did not pass server-side validation."
        echo "The active trust material was not modified."
        ssh $SSH_OPTS "$HOST" "sudo ~/setup-server-remote.sh --trust-release-discard='$RELEASE_ID'" || true
        exit 1
    fi

    DEPLOY_TRUST_ARG="--deploy-trust-release=$(printf '%q' "$RELEASE_ID")"
    echo "Certificates staged and validated (release $RELEASE_ID); activation deferred to setup."

fi

# 3. Execute setup script remotely (this handles git clone/update and service start)
echo "Executing setup script on remote host..."
# Escape every argument with printf %q before interpolating it into the remote
# command string, so a hostile HOSTNAME/REPO_URL/BRANCH/SSH_PORT cannot inject
# shell syntax on the server. Each argument is passed as its own token.
ESCAPED_HOSTNAME=$(printf '%q' "$HOSTNAME")
ESCAPED_REPO_URL=$(printf '%q' "$REPO_URL")
ESCAPED_BRANCH=$(printf '%q' "$BRANCH")
# Pass the boolean as a single `--flag=value` token: a detached
# `--cert-bound-domains false` is parsed as `true` by the remote script (and
# shifts its positionals), silently turning a classic deployment into a
# cert-bound one.
CERT_BOUND_ARG=$(printf '%q' "--cert-bound-domains=$CERT_BOUND_DOMAINS")
SSH_PORT_ARG=""
if [ -n "$SSH_PORT" ]; then
    SSH_PORT_ARG="--ssh-port $(printf '%q' "$SSH_PORT")"
fi
# Activation is part of the remote code/unit/trust transaction, never a separate SSH call.
ssh $SSH_OPTS "$HOST" "chmod +x ~/setup-server-remote.sh && sudo ~/setup-server-remote.sh $ESCAPED_HOSTNAME $ESCAPED_REPO_URL --branch $ESCAPED_BRANCH $CERT_BOUND_ARG $SSH_PORT_ARG $DEPLOY_TRUST_ARG"

echo "Remote setup completed successfully!"

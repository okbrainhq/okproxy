#!/bin/bash

# setup-server-remote.sh
# Purpose: Installs dependencies and prepares the environment for okproxy on Debian.
# Usage:
#   Production: ./setup-server-remote.sh <HOSTNAME> <REPO_URL> [--branch=<branch>] [--cert-bound-domains=true|false] [--ssh-port=<port>]
#   Dev:        ./setup-server-remote.sh --dev
#
# Trust material (server key/cert + CA) is stored in /var/lib/okproxy, outside
# the /opt/okproxy git checkout, and is migrated automatically from the legacy
# in-checkout layout on first run.

set -eo pipefail

# Parse flags
DEV_MODE=false
CERT_BOUND_DOMAINS=true
BRANCH="main"
SSH_PORT="${SSH_PORT:-}"
POSITIONAL=()

while [ $# -gt 0 ]; do
    case "$1" in
        --dev)
            DEV_MODE=true
            shift
            ;;
        --cert-bound-domains)
            # Accept `--cert-bound-domains`, `--cert-bound-domains true|false`
            # and fail closed on anything else instead of silently consuming a
            # positional argument.
            if [ $# -lt 2 ]; then
                CERT_BOUND_DOMAINS=true
                shift
            else
                case "$2" in
                    true|false)
                        CERT_BOUND_DOMAINS="$2"
                        shift 2
                        ;;
                    --*)
                        CERT_BOUND_DOMAINS=true
                        shift
                        ;;
                    *)
                        echo "Error: --cert-bound-domains expects true or false (got: $2)"
                        exit 1
                        ;;
                esac
            fi
            ;;
        --cert-bound-domains=*)
            CERT_BOUND_DOMAINS="${1#--cert-bound-domains=}"
            if [ "$CERT_BOUND_DOMAINS" != true ] && [ "$CERT_BOUND_DOMAINS" != false ]; then
                echo "Error: --cert-bound-domains expects true or false (got: $CERT_BOUND_DOMAINS)"
                exit 1
            fi
            shift
            ;;
        --ssh-port)
            if [ $# -lt 2 ]; then
                echo "Error: --ssh-port requires a port number"
                exit 1
            fi
            SSH_PORT="$2"
            shift 2
            ;;
        --ssh-port=*)
            SSH_PORT="${1#--ssh-port=}"
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

# Validate the boolean form exactly once, so no code path can end up with a
# value that compares unequal to both true and false.
if [ "$CERT_BOUND_DOMAINS" != true ] && [ "$CERT_BOUND_DOMAINS" != false ]; then
    echo "Error: --cert-bound-domains must be true or false (got: $CERT_BOUND_DOMAINS)"
    exit 1
fi

APP_DIR="/opt/okproxy"

# ============================================================
# Persistent data layout (kept OUTSIDE the replaceable checkout)
# ============================================================
# The application checkout (/opt/okproxy) is a git working tree that a deploy
# may clone or hard-reset. Certificates and the CA index are irreplaceable
# trust material, so they live under DATA_DIR and are never touched by
# checkout operations. Legacy in-checkout locations are migrated once.
DATA_DIR="/var/lib/okproxy"
CERT_DIR="$DATA_DIR/certs"
CA_DIR="$DATA_DIR/ca"

# ------------------------------------------------------------ pure helpers
# These helpers are unit-tested by tests/deploy. Sourcing this file with
# OKPROXY_DEPLOY_SOURCE_ONLY=1 stops execution right after they are defined.
systemd_escape_arg() {
    # Serialize one argument for a systemd unit ExecStart token.
    #   - wrap the token in double quotes
    #   - escape backslash and double quote (unit-file quoting rules)
    #   - double % (systemd specifier expansion)
    #   - double $ (disables ExecStart variable expansion for this token)
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//%/%%}"
    # Single-quoted replacement: '$$' must stay literal (an unquoted $$ would
    # expand to the shell PID).
    s="${s//'$'/'$$'}"
    printf '"%s"' "$s"
}

systemd_escape_value() {
    # Escape a free-form single-line unit value (Description=, etc.).
    local s="$1"
    s="${s//$'\n'/ }"
    s="${s//$'\r'/ }"
    s="${s//%/%%}"
    printf '%s' "$s"
}

readwrite_paths() {
    # Required directories (created before the unit starts) are listed
    # unconditionally. Legacy hidden paths are optional: systemd must not fail
    # the unit when they do not exist, so they get the '-' (ignore-if-missing)
    # prefix.
    local paths="$CERT_DIR $CA_DIR" p
    for p in "${APP_DIR:-/opt/okproxy}/.certs" "${APP_DIR:-/opt/okproxy}/.ca"; do
        if [ -d "$p" ]; then
            paths="$paths $p"
        else
            paths="$paths -$p"
        fi
    done
    printf '%s' "$paths"
}

render_okproxy_unit() {
    # Renders the okproxy server unit. Kept as a function so tests can assert
    # on the generated unit without installing anything.
    cat <<EOF
[Unit]
Description=OKProxy Tunnel Server
After=network.target

[Service]
Type=simple
User=okproxy
Group=okproxy
WorkingDirectory=$APP_DIR
ExecStart=$(systemd_escape_arg "$NODE_PATH") apps/server/index.js --http-port 8080 --tls-port 9443 --max-body-size 230686720 --stream-timeout 300000 $CERT_OPTS $SERVER_MODE_OPTS
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$(readwrite_paths)
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
}

# ------------------------------------------------------- trust material helpers
# Privileged command prefix for filesystem operations. Tests override it
# (OKPROXY_AS_ROOT="") so the migration/validation logic can run entirely inside
# a sandbox without touching the host.
AS_ROOT="${OKPROXY_AS_ROOT-sudo}"

cert_signed_by_ca() {
    # $1 = leaf certificate, $2 = CA certificate
    if [ ! -f "$1" ] || [ ! -f "$2" ]; then
        return 1
    fi
    openssl verify -CAfile "$2" "$1" >/dev/null 2>&1
}

key_matches_cert() {
    # $1 = private key, $2 = certificate
    local key_pub cert_pub
    if [ ! -f "$1" ] || [ ! -f "$2" ]; then
        return 1
    fi
    key_pub="$(openssl pkey -pubout -in "$1" 2>/dev/null | openssl sha256 2>/dev/null || true)"
    cert_pub="$(openssl x509 -noout -pubkey -in "$2" 2>/dev/null | openssl sha256 2>/dev/null || true)"
    if [ -z "$key_pub" ] || [ -z "$cert_pub" ]; then
        return 1
    fi
    [ "$key_pub" = "$cert_pub" ]
}

server_pair_is_coherent() {
    # $1 = cert dir, $2 = CA dir
    # Complete server pair whose key matches the cert and whose cert chains to
    # the CA. The CA private key is intentionally not required (uploaded
    # deployments never carry ca-key.pem).
    local cert_dir="$1" ca_dir="$2"
    [ -f "$cert_dir/server-cert.pem" ] || return 1
    [ -f "$cert_dir/server-key.pem" ] || return 1
    [ -f "$ca_dir/ca-cert.pem" ] || return 1
    key_matches_cert "$cert_dir/server-key.pem" "$cert_dir/server-cert.pem" || return 1
    cert_signed_by_ca "$cert_dir/server-cert.pem" "$ca_dir/ca-cert.pem" || return 1
    return 0
}

migrate_legacy_trust_material() {
    # Copy (never move/delete) trust material from the legacy in-checkout layout
    # into DATA_DIR while preserving the coherent *set* the running service used.
    # Certificates, their key and the CA are only migrated together and only
    # after cryptographic validation; partial, incoherent or ambiguous layouts
    # abort instead of guessing.
    local cert_present=false key_present=false ca_present=false
    [ -f "$CERT_DIR/server-cert.pem" ] && cert_present=true
    [ -f "$CERT_DIR/server-key.pem" ] && key_present=true
    [ -f "$CA_DIR/ca-cert.pem" ] && ca_present=true

    $AS_ROOT mkdir -p "$CERT_DIR" "$CA_DIR"

    # Already complete and coherent: the persistent layout wins.
    if server_pair_is_coherent "$CERT_DIR" "$CA_DIR"; then
        return 0
    fi

    # Historical precedence: the uploaded layout (<app>/certs [+ <app>/ca]) was
    # preferred over the generated one (<app>/.certs [+ <app>/.ca]). A server
    # pair and its CA directory are always migrated as one coherent set; the
    # first eligible layout therefore wins, which is exactly the set the
    # running service used.
    local candidate sibling
    local src_cert="" src_ca=""
    for candidate in "$APP_DIR/certs" "$APP_DIR/.certs"; do
        [ -d "$candidate" ] || continue
        if [ ! -f "$candidate/server-cert.pem" ] && [ ! -f "$candidate/server-key.pem" ]; then
            continue
        fi
        case "$candidate" in
            */certs) sibling="$APP_DIR/ca" ;;
            */.certs) sibling="$APP_DIR/.ca" ;;
            *) sibling="$candidate" ;;
        esac
        if [ ! -f "$sibling/ca-cert.pem" ] && [ -f "$candidate/ca-cert.pem" ]; then
            # The uploaded layout also kept a CA copy inside the cert directory.
            sibling="$candidate"
        fi
        if ! server_pair_is_coherent "$candidate" "$sibling"; then
            echo "Error: legacy trust layout $candidate (CA: $sibling) is incomplete or incoherent."
            echo "Required: server-key.pem, server-cert.pem signed by $sibling/ca-cert.pem."
            echo "Refusing to guess which trust material the running service uses."
            exit 1
        fi
        if [ -n "$src_cert" ]; then
            if ! cmp -s "$src_cert/server-cert.pem" "$candidate/server-cert.pem" \
                || ! cmp -s "$src_ca/ca-cert.pem" "$sibling/ca-cert.pem"; then
                echo "Warning: an additional legacy trust layout exists at $candidate (CA: $sibling)."
                echo "         Keeping the historically active set $src_cert + $src_ca."
            fi
            continue
        fi
        src_cert="$candidate"
        src_ca="$sibling"
    done

    if [ -z "$src_cert" ]; then
        # No legacy server pair: still carry over a legacy CA (with its key) so a
        # CA that client certificates were issued from is never regenerated.
        local ca_src="" ca_candidate
        for ca_candidate in "$APP_DIR/ca" "$APP_DIR/.ca" "$APP_DIR/certs" "$APP_DIR/.certs"; do
            [ -f "$ca_candidate/ca-cert.pem" ] || continue
            if [ -n "$ca_src" ]; then
                if ! cmp -s "$ca_src/ca-cert.pem" "$ca_candidate/ca-cert.pem"; then
                    echo "Error: multiple different legacy CA certificates found ($ca_src, $ca_candidate)."
                    echo "Refusing to guess which CA the existing clients trust. Move one aside, then re-run."
                    exit 1
                fi
                continue
            fi
            ca_src="$ca_candidate"
        done
        if [ -n "$ca_src" ] && [ "$ca_present" != true ]; then
            if [ -d "$CA_DIR" ] && [ -n "$(ls -A "$CA_DIR" 2>/dev/null || true)" ]; then
                echo "Error: $CA_DIR already contains files but no CA certificate:"
                echo "$(trust_dir_entries)"
                echo "Refusing to overwrite them with the legacy CA (recoverable key/index/revocation material)."
                echo "Restore the missing CA certificate, or move $CA_DIR aside, then re-run."
                exit 1
            fi
            if [ ! -f "$ca_src/ca-key.pem" ]; then
                echo "Error: legacy CA $ca_src has no private key (ca-key.pem); cannot issue a server"
                echo "certificate from it, and regenerating the CA would invalidate issued client certs."
                exit 1
            fi
            echo "Migrating legacy CA from $ca_src to $CA_DIR (no legacy server pair found)..."
            $AS_ROOT cp -a "$ca_src/." "$CA_DIR/"
        fi
        if [ "$ca_present" != true ] && [ ! -f "$CA_DIR/ca-cert.pem" ] \
            && { [ "$cert_present" = true ] || [ "$key_present" = true ]; }; then
            echo "Error: $DATA_DIR holds an incomplete server key pair and no CA."
            echo "Refusing to regenerate a CA next to an existing server identity."
            echo "Repair or clear $DATA_DIR, then re-run."
            exit 1
        fi
        return 0
    fi

    if [ "$ca_present" = true ] && ! cmp -s "$CA_DIR/ca-cert.pem" "$src_ca/ca-cert.pem"; then
        echo "Error: two different CAs are present:"
        echo "  persistent: $CA_DIR/ca-cert.pem"
        echo "  legacy:     $src_ca/ca-cert.pem"
        echo "Refusing to guess which CA the existing clients trust. Move one aside, then re-run."
        exit 1
    fi
    if [ "$cert_present" = true ] && [ "$key_present" = true ] \
        && ! cert_signed_by_ca "$CERT_DIR/server-cert.pem" "$src_ca/ca-cert.pem"; then
        echo "Error: the persistent server certificate is not signed by the legacy CA."
        echo "  persistent: $CERT_DIR/server-cert.pem"
        echo "  legacy CA:  $src_ca/ca-cert.pem"
        echo "Refusing to mix trust sets. Repair or clear $DATA_DIR, then re-run."
        exit 1
    fi

    if [ "$ca_present" != true ]; then
        # Never overwrite partial/unrecognised material in the destination:
        # a CA key, index, revocation or leaf key may still be recoverable.
        if [ -d "$CA_DIR" ] && [ -n "$(ls -A "$CA_DIR" 2>/dev/null || true)" ]; then
            echo "Error: $CA_DIR already contains files but no CA certificate:"
            echo "$(trust_dir_entries)"
            echo "Refusing to overwrite them with the legacy CA (recoverable key/index/revocation material)."
            echo "Restore the missing CA certificate, or move $CA_DIR aside, then re-run."
            exit 1
        fi
        echo "Migrating legacy CA from $src_ca to $CA_DIR..."
        $AS_ROOT cp -a "$src_ca/." "$CA_DIR/"
    fi
    if [ "$cert_present" != true ] || [ "$key_present" != true ]; then
        if [ -d "$CERT_DIR" ] && [ -n "$(ls -A "$CERT_DIR" 2>/dev/null || true)" ]; then
            echo "Error: $CERT_DIR already contains files but no complete server key pair:"
            echo "$(trust_dir_entries)"
            echo "Refusing to overwrite them with the legacy certificate pair."
            echo "Restore the missing file(s), or move $CERT_DIR aside, then re-run."
            exit 1
        fi
        echo "Migrating legacy server certificate pair from $src_cert to $CERT_DIR..."
        $AS_ROOT cp -a "$src_cert/." "$CERT_DIR/"
    fi

    if ! server_pair_is_coherent "$CERT_DIR" "$CA_DIR"; then
        echo "Error: trust material in $DATA_DIR is still incomplete or incoherent after migration."
        echo "Inspect $CERT_DIR and $CA_DIR, then re-run."
        exit 1
    fi
    return 0
}

legacy_app_dir_is_safe_to_replace() {
    # Only auto-replace a non-git APP_DIR that contains nothing but previously
    # known deployment artifacts. Unknown operator data is never deleted.
    local entry
    for entry in "$APP_DIR"/* "$APP_DIR"/.[!.]*; do
        [ -e "$entry" ] || continue
        case "$(basename "$entry")" in
            certs|ca|.certs|.ca|.gitignore|.git) ;;
            *) return 1 ;;
        esac
    done
    return 0
}

trust_dirs_empty() {
    # True only when every trust directory is *completely* empty, hidden files
    # included. Any remaining entry means recoverable material (a CA key, index,
    # revocation or leaf key) that must never be initialised over.
    local dir entries
    for dir in "$CERT_DIR" "$CA_DIR"; do
        if [ -d "$dir" ]; then
            entries="$(ls -A "$dir" 2>/dev/null || true)"
            if [ -n "$entries" ]; then
                return 1
            fi
        fi
    done
    return 0
}

trust_dir_entries() {
    # Human-readable listing of any unexpected entries (for error messages).
    local dir entries
    local out=""
    for dir in "$CERT_DIR" "$CA_DIR"; do
        if [ -d "$dir" ]; then
            entries="$(ls -A "$dir" 2>/dev/null || true)"
            if [ -n "$entries" ]; then
                out="$out
  $dir: $(printf '%s ' $entries)"
            fi
        fi
    done
    printf '%s' "$out"
}

ensure_server_trust_set() {
    # Select or create the server trust set. An existing CA is never
    # regenerated: if the server pair is missing or incomplete it is re-issued
    # from the existing CA (which requires ca-key.pem). `init` (which creates a
    # new CA) runs ONLY when the trust state is genuinely empty; any partial
    # material aborts so nothing recoverable is destroyed.
    local ca_cert_present=false ca_key_present=false pair_present=false
    [ -f "$CA_DIR/ca-cert.pem" ] && ca_cert_present=true
    [ -f "$CA_DIR/ca-key.pem" ] && ca_key_present=true
    if [ -f "$CERT_DIR/server-cert.pem" ] && [ -f "$CERT_DIR/server-key.pem" ]; then
        pair_present=true
    fi

    # 1. Complete pair + CA certificate: use it when it is coherent.
    if [ "$pair_present" = true ] && [ "$ca_cert_present" = true ]; then
        if server_pair_is_coherent "$CERT_DIR" "$CA_DIR"; then
            echo "Using server certificates from $CERT_DIR (validated against $CA_DIR/ca-cert.pem)."
            return 0
        fi
        echo "Error: $CERT_DIR/server-cert.pem, its key and $CA_DIR/ca-cert.pem are not a matching set."
        echo "Refusing to overwrite them automatically. Repair or remove the offending file, then re-run."
        exit 1
    fi

    # 2. CA certificate without its private key: cannot issue a server
    #    certificate, and must not regenerate the CA.
    if [ "$ca_cert_present" = true ] && [ "$ca_key_present" != true ]; then
        echo "Error: $CA_DIR/ca-cert.pem exists but its private key ($CA_DIR/ca-key.pem) is missing."
        echo "Refusing to regenerate the CA: that would invalidate every issued client certificate."
        echo "Restore ca-key.pem, or upload the server certificate/key together with the CA."
        exit 1
    fi

    # 3. Intact CA (cert + key): re-issue the server pair from it.
    if [ "$ca_cert_present" = true ] && [ "$ca_key_present" = true ]; then
        if [ "$pair_present" != true ] \
            && { [ -f "$CERT_DIR/server-cert.pem" ] || [ -f "$CERT_DIR/server-key.pem" ]; }; then
            echo "Warning: $CERT_DIR holds an incomplete server key pair; re-issuing both files from the existing CA."
        fi
        echo "Existing CA found in $CA_DIR; issuing a server certificate from it..."
        ( cd "$APP_DIR" && "$NODE_PATH" apps/server/bin/tunnel-ca.js issue-server \
            --hostname "$HOSTNAME" --output "$CERT_DIR" --ca-dir "$CA_DIR" )
    else
        # 4. Anything that is not genuinely empty is partial/unrecognised
        #    material (e.g. CA key only, CA records only, orphan leaf, hidden
        #    files). Abort and preserve it.
        if ! trust_dirs_empty; then
            echo "Error: partial or unrecognised trust material found in $DATA_DIR:$(trust_dir_entries)"
            echo "Refusing to initialise a new CA: this would destroy recoverable key/index/revocation material."
            echo "Restore the missing file(s), or move $DATA_DIR aside if the state is intentionally obsolete."
            exit 1
        fi

        # 5. Genuinely empty trust state: first-time initialisation.
        echo "No CA or server certificate found. Generating a new CA and server certificate in $DATA_DIR..."
        ( cd "$APP_DIR" && "$NODE_PATH" apps/server/bin/tunnel-ca.js init --ca-dir "$CA_DIR" )
        if [ ! -f "$CA_DIR/ca-key.pem" ]; then
            echo "Error: CA initialisation did not produce $CA_DIR/ca-key.pem"
            exit 1
        fi
        ( cd "$APP_DIR" && "$NODE_PATH" apps/server/bin/tunnel-ca.js issue-server \
            --hostname "$HOSTNAME" --output "$CERT_DIR" --ca-dir "$CA_DIR" )
    fi

    if ! server_pair_is_coherent "$CERT_DIR" "$CA_DIR"; then
        echo "Error: trust material in $DATA_DIR is incomplete or does not match."
        exit 1
    fi
    echo "Trust material ready in $DATA_DIR."
}

# ------------------------------------------------------------ firewall helpers
detect_management_ports() {
    # Print the SSH management port(s) that must stay reachable. Prefers an
    # explicit --ssh-port/SSH_PORT, then intersects live listeners with the sshd
    # configuration. Prints nothing when the port cannot be determined: callers
    # must fail closed instead of assuming 22.
    local ports sshd_ports port matched=""
    if [ -n "$SSH_PORT" ]; then
        printf '%s' "$SSH_PORT"
        return 0
    fi
    ports="$( { command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null || true; } \
        | awk '{print $4}' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | sort -u | tr '\n' ' ' )"
    sshd_ports="$( { command -v sshd >/dev/null 2>&1 && $AS_ROOT sshd -T 2>/dev/null || true; } \
        | awk '$1 == "port" {print $2}' | sort -u | tr '\n' ' ' )"
    if [ -n "$sshd_ports" ]; then
        for port in $sshd_ports; do
            case " $ports " in
                *" $port "*) matched="$matched $port" ;;
            esac
        done
        if [ -n "$matched" ]; then
            printf '%s' "$matched"
        else
            # Configured but not yet listening (e.g. restart pending): trust the
            # daemon configuration.
            printf '%s' "$sshd_ports"
        fi
        return 0
    fi
    printf ''
}

ufw_allowed_tcp_ports() {
    # Only exact forms count: "<port>/tcp", a bare "<port>" token, or
    # "... port <port> ...". Ranges and other forms are intentionally not
    # interpreted (the operator must add an explicit rule).
    printf '%s\n' "$1" | awk '
        tolower($0) ~ /allow/ {
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^[0-9][0-9]*\/tcp$/) { sub(/\/tcp$/, "", $i); print $i }
                else if ($i ~ /^[0-9][0-9]*$/) print $i
                else if ($i == "port" && $(i + 1) ~ /^[0-9][0-9]*$/) print $(i + 1)
            }
        }' | sort -u | tr '\n' ' '
}

ufw_deny_lines() {
    # ANY deny/reject rule is returned, regardless of port form (bare port,
    # "N/tcp", range "N:M", source-only, etc.). Parsing cannot prove such rules
    # harmless, so firewall_precheck() refuses to enable UFW when any exist.
    # The status header ("Default: deny (incoming), ...") is not a rule.
    printf '%s\n' "$1" | grep -Ev '^[[:space:]]*Default:' \
        | grep -Ei '(^|[[:space:]])(deny|reject)([[:space:]]|$)' || true
}

firewall_precheck() {
    # $1 = management port(s), $2 = ufw rule text.
    # Prints an error message and returns 1 when UFW must not be enabled; prints
    # nothing and returns 0 only when the rule set has no deny/reject rule at all
    # and every management port is allowed by an exact rule.
    local ports="$1" rules="$2"
    local allowed port deny_lines
    if [ -z "$(printf '%s' "$rules" | tr -d '[:space:]')" ]; then
        printf '%s' "could not read the UFW rule set (ufw show added/status returned nothing)"
        return 1
    fi

    # Conservative: do not try to reason about deny/reject shadowing (bare
    # ports, port ranges, address-scoped rules). Hands-off and fail closed.
    deny_lines="$(ufw_deny_lines "$rules" | head -3)"
    if [ -n "$deny_lines" ]; then
        printf 'UFW contains deny/reject rule(s) whose effect cannot be proven safe:\n%s\nReview them manually (sudo ufw status numbered) and remove or resolve them before re-running' "$deny_lines"
        return 1
    fi

    allowed="$(ufw_allowed_tcp_ports "$rules")"
    for port in $ports; do
        case " $allowed " in
            *" $port "*) ;;
            *)
                printf 'management port %s is not allowed by an exact UFW rule (add: sudo ufw allow %s/tcp)' "$port" "$port"
                return 1
                ;;
        esac
    done
    return 0
}

apply_firewall_rules() {
    # $1 = verified management port(s), space separated.
    #
    # Ordering is safety-critical and enforced here:
    #   1. read the existing rule set (no mutation)
    #   2. fail closed on any deny/reject rule BEFORE changing anything
    #   3. add allowances only (additive; safe on an already-active firewall)
    #   4. verify the management allowances exist BEFORE any restrictive default
    #   5. only then apply `default deny incoming` / `default allow outgoing`
    #   6. re-verify, then enable
    # A failure therefore never leaves a host with a restrictive incoming default
    # and no management allowance. Returns non-zero with the reason on stdout.
    local mgmt_ports="$1"
    local rules reasons port

    # 1. Current state. No mutation.
    rules="$($AS_ROOT ufw show added 2>/dev/null || $AS_ROOT ufw status 2>/dev/null || true)"

    # 2. Unprovable deny/reject rules abort before any change.
    reasons="$(ufw_deny_lines "$rules")"
    if [ -n "$reasons" ]; then
        printf 'existing UFW rules contain deny/reject entries whose effect cannot be proven safe:\n%s\n' "$reasons"
        printf '%s\n' "Review them manually (sudo ufw status numbered), then re-run. No firewall change was made."
        return 1
    fi

    # 3. Additive allowances.
    for port in $mgmt_ports; do
        $AS_ROOT ufw allow "$port/tcp" || return 1
    done
    $AS_ROOT ufw allow 80/tcp || return 1
    $AS_ROOT ufw allow 443/tcp || return 1
    $AS_ROOT ufw allow 9443/tcp || return 1

    # 4. Verify management allowances BEFORE applying any default policy.
    rules="$($AS_ROOT ufw show added 2>/dev/null || $AS_ROOT ufw status 2>/dev/null || true)"
    if ! reasons="$(firewall_precheck "$mgmt_ports" "$rules")"; then
        printf '%s\n' "$reasons"
        printf '%s\n' "Refusing to continue: no default policy was changed and the firewall was not enabled."
        return 1
    fi

    # 5. Restrictive defaults, only now that management access is proven allowed.
    $AS_ROOT ufw default deny incoming || return 1
    $AS_ROOT ufw default allow outgoing || return 1

    # 6. Re-verify that the new default does not shadow the management ports.
    rules="$($AS_ROOT ufw show added 2>/dev/null || $AS_ROOT ufw status 2>/dev/null || true)"
    if ! reasons="$(firewall_precheck "$mgmt_ports" "$rules")"; then
        printf '%s\n' "$reasons"
        printf '%s\n' "The incoming default is now 'deny' but management ports were allowed first."
        printf '%s\n' "Restore the previous policy manually with: sudo ufw default allow incoming"
        return 1
    fi

    # 7. Enable.
    $AS_ROOT ufw --force enable || return 1
    return 0
}

if [ "${OKPROXY_DEPLOY_SOURCE_ONLY:-0}" = "1" ]; then
    return 0
fi

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
LTS_DATA=$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null || echo "")

if [ -n "$LTS_DATA" ]; then
    # Find first entry with "lts":"codename" (not "lts":false)
    # Extract the version from the first LTS entry
    # Split entries on '}' and take the first chunk that contains a string "lts" (entries contain nested objects).
    # '|| true' prevents 'set -e' from aborting the whole script if the JSON shape changes or no LTS entry is found.
    TARGET_VERSION=$(echo "$LTS_DATA" | tr '}' '\n' | grep '"lts":"' | head -1 | sed -E 's/.*"version":"(v[0-9]+)\..*/\1/' || true)
    TARGET_MAJOR=$(echo "$TARGET_VERSION" | grep -oE '[0-9]+' || true)

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

    # 5. Migrate legacy trust material, then clone or update the checkout
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
        # Rescue any trust material living inside the old layout *before* the
        # directory is replaced. This is a copy, so keys survive even if the
        # checkout is later removed.
        migrate_legacy_trust_material
        if [ -d "$APP_DIR" ]; then
            if [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ] && ! legacy_app_dir_is_safe_to_replace; then
                echo "Error: $APP_DIR exists, is not a git checkout, and holds files this script does not manage."
                echo "Refusing to delete it. Move it aside and re-run."
                exit 1
            fi
            sudo rm -rf "$APP_DIR"
        fi
        # Create and own only the application directory itself. Never chown the
        # parent (/opt) recursively.
        sudo mkdir -p "$APP_DIR"
        sudo chown "$REAL_USER":"$REAL_USER" "$APP_DIR"
        git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
        echo "Repository cloned."
    fi
    # Also migrate on the update path so a pre-existing in-checkout layout is
    # moved out even when the git working tree already exists.
    migrate_legacy_trust_material

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

    # 6. Establish the server trust set in the persistent data directory.
    # ensure_server_trust_set() never regenerates an existing CA: a new CA would
    # invalidate every client certificate issued by the old one. If the server
    # pair is missing/incomplete it is re-issued from the existing CA, and any
    # incoherent or partial state fails closed.
    ensure_server_trust_set

    # The server always reads explicit paths; never rely on WorkingDirectory
    # defaults that point inside the checkout.
    CERT_OPTS="--key $CERT_DIR/server-key.pem --cert $CERT_DIR/server-cert.pem --ca $CA_DIR/ca-cert.pem --ca-dir $CA_DIR"
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
    # ReadWritePaths entries must exist; create the required ones explicitly.
    sudo mkdir -p "$CERT_DIR" "$CA_DIR"
    render_okproxy_unit | sudo tee /etc/systemd/system/okproxy.service > /dev/null

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

    # Verify the actual management listener before touching UFW. Unknown port
    # detection or an unverifiable rule set aborts: enabling UFW without the
    # operator's real SSH port would end the session.
    MANAGEMENT_PORTS="$(detect_management_ports)"
    if [ -z "$MANAGEMENT_PORTS" ]; then
        echo "Error: could not determine the SSH management port(s)."
        echo "Refusing to enable UFW without a verified management port."
        echo "Set SSH_PORT in .deploy.server (or pass --ssh-port <port>) and re-run."
        exit 1
    fi
    MGMT_ALLOW=""
    for port in $MANAGEMENT_PORTS; do
        if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
            echo "Error: invalid SSH management port detected: $port"
            exit 1
        fi
        case " $MGMT_ALLOW " in
            *" $port "*) ;;
            *) MGMT_ALLOW="$MGMT_ALLOW $port" ;;
        esac
    done

    sudo apt install -y ufw

    # Firewall changes happen in apply_firewall_rules(), which reads and
    # validates the existing rules BEFORE mutating anything and adds the
    # management allowances BEFORE applying the restrictive incoming default
    # (see the ordering notes there).
    if ! FIREWALL_ERROR="$(apply_firewall_rules "$MGMT_ALLOW" 2>&1)"; then
        echo "Error: $FIREWALL_ERROR"
        echo "Refusing to enable UFW. No restrictive default has been applied unless stated above."
        exit 1
    fi
    echo "Firewall enabled (management SSH ports:$MGMT_ALLOW)"

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

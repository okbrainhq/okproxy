# Ubuntu Client Service (systemd)

How the tunnel client is deployed and operated on Debian/Ubuntu as a systemd service.

- Installer: `scripts/deploy/setup-client-remote-ubuntu.sh`
- Orchestrator: `scripts/deploy/setup-client.sh` (platform aware, picks the Linux installer when the target OS is Linux)
- macOS equivalent: `scripts/deploy/setup-client-remote.sh` (LaunchAgent)

## 1. Overview

The client is a long-running Node.js process that:

1. Opens a mutually authenticated TLS tunnel to the server's TLS port (`--server <host>:<port>`) using the client certificate profile.
2. Registers itself under the **domains found in that certificate's SAN list** (certificate-bound Host routing). Anything the public Caddy asks the tunnel server for that matches those SANs is routed to this client.
3. Proxies every routed HTTP stream to the local target (`--target host:port`) — usually an app on `127.0.0.1`.

On Ubuntu it is supervised by systemd with `Restart=always`, so crashes, cert reloads and host reboots are all handled without manual intervention.

### Deployed instance (reference)

| Item | Value |
|------|-------|
| Host OS | Ubuntu 26.04 (systemd 259, `azero`) |
| Unit | `okproxy-client-a0.service` (`/etc/systemd/system/`) |
| Service scope | system-wide, `User=azero` |
| Server / tunnel port | `d0.arunoda.me:9443` |
| Public hostname (from cert SAN) | `a0.arunoda.me` |
| Local target | `localhost:3000` |
| Client profile / cert dir | `a0` → `/home/azero/.okproxy/certs/a0` |
| App checkout | `/home/azero/okproxy` (`main` @ `0ce07da`) |
| Node.js | `/usr/bin/node` (v22, system package — no download needed) |
| Mode | `--multipath --parallel-sockets 4` |
| Logs | `~/.okproxy/logs/a0/client.log`, `client-error.log` |

## 2. Files and paths

| Path | Purpose | Notes |
|------|---------|-------|
| `$HOME/okproxy` | Cloned application used by the service (`apps/client/index.js`) | Override with `--app-dir` |
| `/etc/systemd/system/okproxy-client-<name>.service` | Unit file (system scope) | `~/.config/systemd/user/…` for user scope |
| `$HOME/.okproxy/certs/<name>/client-cert.pem` | Client certificate presented to the server | SAN list drives routing |
| `$HOME/.okproxy/certs/<name>/client-key.pem` | Private key | chmod `600` |
| `$HOME/.okproxy/certs/<name>/ca-cert.pem` | CA that signed the server certificate | Used to verify the server |
| `$HOME/.okproxy/logs/<name>/client.log` | Client stdout (banner, connects, PING/PONG) | Owned by the service user |
| `$HOME/.okproxy/logs/<name>/client-error.log` | Client stderr (fatal/connection errors) | Should normally be empty |
| `.deploy.client` (project root, git-ignored) | Local deploy configuration | Never committed |

Unit naming: `okproxy-client` for `CLIENT_NAME=default`, otherwise `okproxy-client-<CLIENT_NAME>`.

Cert/domain convention: the cert profile directory name (`a0`) is just a label; the **public hostname comes from the certificate SAN** (`DNS:a0.arunoda.me`). Always keep `CLIENT_NAME` equal to the cert directory name (`~/.okproxy/certs/$CLIENT_NAME`) to avoid mismatch surprises.

## 3. Configuration

`.deploy.client` (git-ignored):

```bash
SERVER_HOST=d0.arunoda.me:9443   # tunnel server host + TLS tunnel port
TARGET_HOST=localhost:3000       # local service to expose
REPO_URL=https://github.com/okbrainhq/okproxy.git
CLIENT_NAME=a0                   # unit name → okproxy-client-a0
CLIENT_CERT_DIR=/home/azero/.okproxy/certs/a0
PARALLEL_SOCKETS=4               # lanes per routable interface
```

Optional keys: `DEPLOY_HOST` (default target for the orchestrator), `SSH_PORT`.

The resulting `ExecStart` (rendered by the installer):

```text
/usr/bin/node /home/azero/okproxy/apps/client/index.js \
  --multipath \
  --server d0.arunoda.me:9443 \
  --target localhost:3000 \
  --parallel-sockets 4 \
  --cert /home/azero/.okproxy/certs/a0/client-cert.pem \
  --key  /home/azero/.okproxy/certs/a0/client-key.pem \
  --ca   /home/azero/.okproxy/certs/a0/ca-cert.pem
```

## 4. Installation and re-deployment

From a project checkout that contains `.deploy.client`:

```bash
# Install/update on this machine (no SSH/SCP)
./scripts/deploy/setup-client.sh --local

# Install/update on a remote Ubuntu host (first run uploads the certs)
./scripts/deploy/setup-client.sh ubuntu@10.0.0.5 --upload-certs
```

Or run the installer directly on the host:

```bash
./scripts/deploy/setup-client-remote-ubuntu.sh <SERVER_HOST> <TARGET_HOST> <REPO_URL> \
  [CLIENT_NAME] [CERT_DIR] [PARALLEL_SOCKETS] [options]
```

### Installer steps

1. **Validation** – requires `SERVER_HOST`, `TARGET_HOST`, `REPO_URL`; expands `~`/relative paths.
2. **Node.js** – uses `--node-path` when given, else a system Node.js ≥ 20, else installs the newest Node.js LTS into `~/.local` (official tarball, SHA-256 verified, `linux-x64`/`linux-arm64`).
3. **App deployment** – clones `REPO_URL` into `$HOME/okproxy` or hard-updates an existing checkout (`git fetch` + `git reset --hard origin/<branch>`, default `main`).
4. **Certificates** – verifies `client-cert.pem`, `client-key.pem`, `ca-cert.pem` exist and chmods the key to `600`.
5. **Service** – writes the unit, `systemctl daemon-reload`, `systemctl enable --now`; system scope when root or passwordless `sudo` is available, otherwise a `systemctl --user` unit plus `loginctl enable-linger`.
6. **Post-start** – chowns the log files to the service user, prints status, and waits up to 30 s for `Connected to TLS tunnel server` in `client.log`.

Re-running is idempotent: the unit is rewritten, the checkout is hard-reset to `origin/<branch>`, certs are re-verified, and the service is restarted.

### Installer options

```text
--app-dir <path>       Repo/app directory on the host (default: $HOME/okproxy)
--branch <name>        Branch to deploy (default: main)
--node-path <path>     Use this Node.js binary instead of auto-detecting one
--service-user <user>  Run the system service as this user (default: current user)
--system               Force a system-wide unit in /etc/systemd/system (needs root/sudo)
--user                 Force a per-user unit in ~/.config/systemd/user
--no-multipath         Single-connection mode instead of multipath
--no-start             Install the unit without enabling/starting it
--help                 Show usage
```

## 5. Unit definition

```ini
[Unit]
Description=okproxy tunnel client (a0)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=azero
WorkingDirectory=/home/azero/okproxy/apps/client
ExecStart=/usr/bin/node /home/azero/okproxy/apps/client/index.js --multipath ...
Restart=always
RestartSec=5
StandardOutput=append:/home/azero/.okproxy/logs/a0/client.log
StandardError=append:/home/azero/.okproxy/logs/a0/client-error.log
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

Rationale:

- `Restart=always` + `RestartSec=5` → a crashed or misconfigured client comes back within ~5 s; a fatal start (`Connected` never reached) exits and restarts instead of hanging.
- The client handles `SIGTERM` (graceful socket close), which is what `systemctl stop/restart` sends.
- `ProtectSystem=full` + `NoNewPrivileges` + `PrivateTmp` keep the service from writing outside `$HOME`; it needs no capabilities and opens no inbound ports.
- `append:` keeps client logs in `~/.okproxy/logs/<name>/` next to the macOS LaunchAgent logs. Note: app output is **not** in the journal — use `journalctl` only for service lifecycle/restart events.

## 6. Certificate lifecycle

| Step | Command / action |
|------|------------------|
| Issue client cert + key (+ CA) on the server | project cert tooling, e.g. `issue-client --name a0 --domain a0.arunoda.me` |
| Place files | `~/.okproxy/certs/a0/{client-cert.pem,client-key.pem,ca-cert.pem}` |
| Tighten key perms | `chmod 600 client-key.pem` (installer does this) |
| Ship to the host | `./scripts/deploy/setup-client.sh <host> --upload-certs --cert-dir ~/.okproxy/certs/a0` or copy manually |
| **Apply** | `sudo systemctl restart okproxy-client-a0` |

**The client reads certificates once at process start.** Replacing the PEM files under a running service has no effect until the unit is restarted — this is the single most common cause of "the tunnel still routes the old domain / the new domain 502s".

Verify which identity the client is using:

```bash
# certificate on disk
openssl x509 -in ~/.okproxy/certs/a0/client-cert.pem -noout -subject -dates -ext subjectAltName

# TLS certificate Caddy serves for the public host (issued on demand)
echo | openssl s_client -connect a0.arunoda.me:443 -servername a0.arunoda.me 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```

Simplest way to apply both a new cert and a new CA (also refreshes file permissions):

```bash
./scripts/deploy/setup-client.sh --local
```

## 7. Operations runbook

### Status and control

```bash
systemctl status okproxy-client-a0            # state, PID, recent journal lines
systemctl is-active okproxy-client-a0         # active | inactive | failed
systemctl is-enabled okproxy-client-a0        # enabled = starts at boot
sudo systemctl restart okproxy-client-a0      # required after cert changes
sudo systemctl stop okproxy-client-a0
sudo systemctl disable --now okproxy-client-a0
sudo systemctl show -p MainPID -p NRestarts -p RestartUSec okproxy-client-a0
```

### Logs

```bash
tail -f ~/.okproxy/logs/a0/client.log         # banner, connects, PING/PONG
tail -f ~/.okproxy/logs/a0/client-error.log   # should stay empty
sudo journalctl -u okproxy-client-a0 -f       # start/stop/restart lifecycle only
```

Healthy steady state:

```text
Connected to TLS tunnel server (multipath ready)
[virtual-socket] Interface wlp130s0#1 connected   (x lanes)
[wlp130s0#1] … sending PING / received PONG
```

### Health checks

```bash
# 1. service is up and connected
systemctl is-active okproxy-client-a0
grep -c "Connected to TLS tunnel server" ~/.okproxy/logs/a0/client.log

# 2. the public domain is allowed to be issued by the tunnel server (Caddy ask endpoint)
curl -s "https://d0.arunoda.me/_okproxy/caddy-ask?domain=a0.arunoda.me"   # -> OK

# 3. DNS for the public hostname points at the tunnel server
getent hosts a0.arunoda.me

# 4. end-to-end through the tunnel (marker test — proves routing to THIS host)
mkdir -p /tmp/okproxy-e2e && echo "marker-$(date +%s)" > /tmp/okproxy-e2e/index.html
(cd /tmp/okproxy-e2e && python3 -m http.server 3000 --bind 127.0.0.1 &)   # stand-in for the real app
sleep 1 && curl -s https://a0.arunoda.me/ && pkill -f "http.server 3000"
```

### Upgrades

- Client code: re-run the installer (`--local` or over SSH) — it hard-resets `$HOME/okproxy` to `origin/main` and restarts the unit.
- Node.js: pass `--node-path /path/to/node` or set `OKPROXY_NODE_PATH`, then re-run the installer.
- Log growth: logs are appended indefinitely; add logrotate if the volume matters:

```text
# /etc/logrotate.d/okproxy-client-a0
/home/azero/.okproxy/logs/a0/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
```

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `502` on the public domain | No tunnel client connected **or** the local target is down. Both look identical from outside. | Check `systemctl is-active` + `Connected to TLS tunnel server` in `client.log`; then start a marker server on `:3000` and retry. |
| Domain routes to another machine / old domain still works | The running process still holds the previous certificate | `sudo systemctl restart okproxy-client-a0` |
| Client reconnects roughly every 1–2 s | Single-connection (`default`) mode colliding with another client's socket name; the server replaces the socket and the client silently reconnects (`ECONNRESET` is suppressed in the client's error handler) | Use `--multipath` (installer default) or isolate the conflicting client |
| `Removing disappeared interface: wlp130s0#N` for every lane at once | Transient network outage: the interface detector's connectivity probe to the server failed, so the client stops using that interface (expected, not an error) | None — lanes are re-added automatically once probes succeed again (see §9). The process stays alive; `Restart=always` does not fire because there is no crash. |
| 404/503 for the public host, `caddy-ask` returns non-OK | The domain is not in the server's issued-domain index / not in any client cert SAN | Re-issue the client cert with the right `--domain`, then restart the unit |
| First request after boot/restart fails for ~5–6 s | Multipath interface probing waits on non-routable interfaces (5 s probe timeout) before the first socket is registered | Expected; retry or set `RestartSec`/retry logic accordingly |
| `client-error.log` has a single line `VirtualSocket error: All connections failed` right after start | Startup race while the first sockets are still probing; it resolves by itself | Ignore if followed by `Connected to TLS tunnel server` |
| Unit exits immediately / restarts constantly | Node path, app dir or cert path invalid (fatal pre-ready exit) | `journalctl -u okproxy-client-a0 -n 50` and fix `ExecStart` paths, or re-run the installer |
| `logs` files owned by `root` | systemd creates the append target as root | Re-run the installer (it chowns the log dir) or `sudo chown -R azero ~/.okproxy/logs/a0` |

Only the routable interface is used: on the reference host, `wlp130s0` connects while `enp129s0` and `okrun0` (VPN) time out — multipath probes interfaces and skips the unreachable ones.

## 9. Verification record (2026-09-12, reference host)

| Check | Result |
|-------|--------|
| `systemctl is-active/is-enabled okproxy-client-a0` | `active` / `enabled` |
| Startup banner | `Multipath: enabled`, `Parallel sockets per interface: 4` |
| Tunnel sockets | `wlp130s0#1..#4 connected`, `Connected to TLS tunnel server (multipath ready)` |
| Keepalive | PING/PONG every 5 s on all 4 lanes, stable over 45 s+ |
| Client cert | `CN=a0`, `SAN DNS:a0.arunoda.me`, EKU `TLS Web Client Authentication`, key `600` |
| Public TLS | `openssl s_client` for `a0.arunoda.me` → `CN=a0.arunoda.me` |
| End-to-end | `curl https://a0.arunoda.me/` → `200` + marker served from local `:3000` |
| Domain isolation | `curl https://d0.arunoda.me/` → `502` (that host is not bound to this client) |
| Crash recovery | `kill -9` of `MainPID` → systemd restarted it, tunnel reconnected (~11 s total, incl. 5 s `RestartSec` + probing) |
| Client-cert swap | Replaced certs (`d0` → `a0`) applied only after `systemctl restart`; routing moved from `d0.arunoda.me` to `a0.arunoda.me` |
| Network outage (unplanned) | Wi-Fi blip at 15:18:01 → all 4 lanes removed at 15:18:06 (probe failed) → lanes re-added automatically at 15:19:16 when the network returned; `NRestarts` stayed `0`, tunnel served `200` afterwards |
| `NRestarts` after 45 s of soak | `0`, `client-error.log` unchanged |

### Recovery behaviour (multipath)

```text
15:18:01  [wlp130s0#1] sending PING          # outbound lost here (no PONG)
15:18:06  [virtual-socket] Removing disappeared interface: wlp130s0#1..#4   # probe failed
15:19:16  [virtual-socket] Interface wlp130s0#1..#4 connected                # network back
15:19:26  [wlp130s0#1..#4] received PING, sending PONG
```

Interpretation: multipath is connectivity-driven — an interface that cannot reach the tunnel server is dropped from the pool and re-added automatically. The service process never exits, so no systemd restart is involved and no operator action is needed.

## 10. Uninstall

```bash
sudo systemctl disable --now okproxy-client-a0
sudo rm /etc/systemd/system/okproxy-client-a0.service
sudo systemctl daemon-reload
# optional: remove local state
rm -rf ~/okproxy ~/.okproxy/logs/a0
# keep ~/.okproxy/certs/a0 if the cert profile is still needed
```

For a per-user install, drop `/etc/systemd/system` for `~/.config/systemd/user`, use `systemctl --user …`, and optionally `loginctl disable-linger <user>`.

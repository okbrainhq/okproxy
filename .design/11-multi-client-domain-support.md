# 11 — Certificate-Bound Multi-Client Domain Support

## Overview

Add first-class support for running many independent okproxy tunnel clients behind one server, without requiring a hand-written server routing config.

The new model is **domains are authorized at client certificate issuance time**:

1. The operator issues a client mTLS certificate with one or more public domains embedded in the certificate.
2. The tunnel client connects with that certificate/key pair.
3. The server verifies the certificate against the okproxy CA.
4. The server extracts the authorized domains from the peer certificate.
5. The server creates or updates a runtime mapping:
   - `domain → connected certificate serial/session`
6. Public HTTP/WebSocket traffic is routed by `Host` header to the connected session authorized for that domain.

This removes the unsafe “client claims arbitrary domains at connect time” model. A client can only serve domains already approved by the okproxy CA when the client certificate was created.

Caddy remains the public HTTPS terminator. It should use **On-Demand TLS** with an `ask` endpoint served by okproxy. The ask endpoint allows certificate issuance only for domains known from okproxy-issued client certificates, not from unauthenticated browser traffic.

---

## Key Security Property

If a client certificate/key leaks, the attacker can only connect as that certificate and serve the domains already embedded in that certificate.

They **cannot claim new domains**, because:

- The server ignores untrusted client-provided domain claims.
- Authorized domains come from the CA-signed client certificate.
- Only the CA/operator can issue a new certificate containing additional domains.

The leak still matters: the attacker can impersonate that client for the embedded domains until the certificate serial is revoked. So the operational response is:

1. Revoke the leaked certificate serial.
2. Issue a replacement certificate for the legitimate client.
3. Restart/reload affected clients if needed.
4. Ensure Caddy ask logic rejects domains whose only authorizing cert is revoked.

Recommended blast-radius rule: issue small-scoped certificates, ideally one client/application per certificate.

---

## Terminology

- **Public domain**: User-facing domain such as `acme.example.com`. DNS A/AAAA points to the okproxy server IP.
- **Tunnel server host**: Host clients use for the mTLS tunnel connection on port `9443`, for example `tunnel.example.com:9443`.
- **Tunnel client**: Client-side okproxy process that forwards traffic to a local target such as `localhost:3000`.
- **Client certificate**: mTLS certificate issued by okproxy CA and used by the tunnel client.
- **Certificate serial**: Stable mTLS certificate identifier used for sessions, logs, and revocation.
- **Certificate-bound domain**: Domain embedded in the client certificate as an authorized public domain.
- **Issued domain index**: Server-side CA metadata generated when certificates are issued/revoked. Used by the Caddy ask endpoint.
- **Client session**: Runtime state for one connected certificate serial, including its connection pool and stream handlers.

---

## Current Architecture

Today the server is intentionally single-active-client:

- `apps/server/index.js` creates one global `ConnectionPool`.
- `apps/server/lib/tls-server.js` accepts mTLS connections and registers each connection in that global pool.
- `apps/server/lib/connection-pool.js` stores one active `clientSerial`; a different client serial is rejected while any connection exists.
- `apps/server/lib/http-router.js` sends every public HTTP/WebSocket request to the same global pool.
- `apps/client/lib/proxy.js` forwards all tunnel streams to one local target configured with `--target`.
- Caddy currently has one site block for one `HOSTNAME` and reverse proxies to the server HTTP listener.

This model is simple and safe for one client, but it prevents independent clients from sharing one server.

---

## Goals

- Support many independent clients connected to one server.
- Avoid hand-maintained per-domain server routing config.
- Bind allowed public domains to CA-issued client certificates.
- Prevent clients from claiming domains at runtime.
- Route requests by exact domain match from the HTTP `Host` header.
- Isolate clients completely:
  - connection pools
  - active streams
  - stream handlers
  - stream ID allocation
  - multipath virtual socket state
  - WebSocket state
- Keep mTLS as the source of client authentication and domain authorization.
- Preserve multipath support per certificate serial.
- Let Caddy handle dynamic HTTPS certificates with On-Demand TLS.
- Preserve legacy single-client behavior when certificate-bound routing is disabled.
- Keep the codebase dependency-free unless implementation explicitly chooses otherwise.

---

## Non-Goals

- Letting clients self-register arbitrary domains during `INIT`.
- Public self-service domain transfer UI.
- Browser-first domain registration.
- Database-backed admin management in v1.
- Wildcard domain authorization in v1.
- SNI-level routing for tunnel connections.
- Replacing Caddy as the public TLS terminator.

---

## Proposed Architecture

Certificate issuance defines ownership:

```text
Operator
  ↓ tunnel-ca issue-client --domain acme.example.com
okproxy CA
  ↓ client cert contains DNS:acme.example.com
Tunnel Client(acme)
  ↓ mTLS with cert serial=1
TLS Server
  ↓ extracts authorizedDomains=["acme.example.com"]
ClientSession(serial 1)
  ↓ dedicated ConnectionPool
```

Public traffic routes through Caddy and okproxy:

```text
Browser
  ↓ SNI/Host: acme.example.com
Caddy On-Demand TLS
  ↓ ask /_okproxy/caddy-ask?domain=acme.example.com
Okproxy ask endpoint
  ↓ issued domain index says allowed and not revoked
Caddy reverse_proxy 127.0.0.1:8080
  ↓ Host: acme.example.com
HTTP Router
  ↓ resolve Host against active sessions
ClientSession(serial 1)
  ↓ dedicated ConnectionPool
Tunnel Client(serial 1)
  ↓ localhost:3000
Target App
```

Each active certificate serial gets a `ClientSession`. The session owns all state that must not leak across clients.

```text
MultiClientManager
  sessionsBySerial:
    1 → ClientSession(serial=1, domains=[acme.example.com])
    2 → ClientSession(serial=2, domains=[beta.example.com])

  activeDomainRoutes:
    acme.example.com → serial 1
    beta.example.com → serial 2
```

---

## Certificate Domain Encoding

### Recommended v1: Subject Alternative Name DNS entries

Use X.509 Subject Alternative Name DNS entries to encode public domains:

```text
X509v3 Subject Alternative Name:
  DNS:acme.example.com,
  DNS:www.acme.example.com

X509v3 Extended Key Usage:
  TLS Web Client Authentication
```

The client certificate is still a tunnel mTLS certificate. Browsers never see this certificate. It is only used between the tunnel client and okproxy server.

### Optional later: private okproxy extension

If we want to avoid overloading SAN DNS entries, we can later add a private extension OID such as:

```text
1.3.6.1.4.1.<private>.okproxy.authorizedDomains = JSON/StringList
```

For v1, SAN DNS entries are simpler and easier to inspect with standard tools.

---

## CA CLI Changes

Extend `apps/server/bin/tunnel-ca.js issue-client`:

```bash
node apps/server/bin/tunnel-ca.js issue-client \
  --name acme \
  --domain acme.example.com \
  --domain www.acme.example.com \
  --output ./.certs/clients/acme
```

Behavior:

- Validate every `--domain` value.
- Normalize domains to lowercase ASCII/punycode form.
- Reject duplicate domains in the same cert.
- Reject wildcard domains in v1.
- Add domains as SAN DNS entries.
- Add EKU `clientAuth`.
- Write/update CA metadata so the server can answer Caddy ask requests.

Example issued metadata:

```json
{
  "serial": "1",
  "name": "acme",
  "status": "valid",
  "issuedAt": "2026-06-16T00:00:00.000Z",
  "domains": ["acme.example.com", "www.acme.example.com"]
}
```

---

## Issued Domain Index

Although no hand-written routing config is needed, Caddy needs a stable authorization source for On-Demand TLS.

Recommended index generated by the CA tooling:

```text
/etc/okproxy/
  ca/
    certs.json
    revoked.json
    issued-domains.json
```

Example `issued-domains.json`:

```json
{
  "version": 1,
  "domains": {
    "acme.example.com": {
      "serials": ["1"],
      "status": "valid"
    },
    "www.acme.example.com": {
      "serials": ["1"],
      "status": "valid"
    },
    "beta.example.com": {
      "serials": ["2"],
      "status": "valid"
    }
  }
}
```

This file is not manual configuration. It is CA-issued state derived from certificates.

The ask endpoint can also compute this from existing CA metadata at startup, but a denormalized index keeps lookups simple and fast.

---

## Domain Authorization Rules

When a tunnel client connects:

1. TLS verifies the client certificate chain against okproxy CA.
2. Server checks certificate serial is not revoked.
3. Server extracts certificate SAN DNS domains.
4. Server validates and normalizes each domain.
5. Server creates or updates `ClientSession(serial)`.
6. Server registers active routes for those domains:
   - `domain → serial`

Important rules:

- Runtime client `INIT` must not grant domains.
- If `INIT` includes domains, they are treated only as requested subset/diagnostics.
- If `INIT` asks for a domain not present in the cert, reject the connection or ignore that domain with an error.
- If two currently valid certs contain the same domain, this is a CA/operator error and should fail closed.
- Revoked certs cannot connect and cannot authorize Caddy ask responses.

---

## Handling Duplicate Domains

Preferred v1 policy: **one active valid certificate per domain**.

During certificate issuance:

- Reject issuing a new valid certificate for a domain already present in another valid, non-revoked certificate.
- For rotation, explicitly allow an overlap mode:

```bash
node apps/server/bin/tunnel-ca.js issue-client \
  --name acme-v2 \
  --domain acme.example.com \
  --allow-domain-overlap \
  --output ./.certs/clients/acme-v2
```

During overlap:

- Existing connected serial keeps serving the domain.
- New serial can connect but should not take over until old serial disconnects or is revoked.
- Operator should revoke old serial after cutover.

Simpler alternative for v1: require revoking the old certificate before issuing the new one for the same domain.

---

## MultiClientManager

Add a server-side manager that owns runtime client sessions:

```js
class MultiClientManager {
  constructor({ caStore }) {
    this.caStore = caStore;
    this.sessionsBySerial = new Map();
    this.activeRoutesByDomain = new Map();
  }

  addTunnelConnection({ serial, cert, interfaceName, socket }) {
    if (this.caStore.isRevoked(serial)) return false;

    const domains = extractAuthorizedDomains(cert);
    if (domains.length === 0) return false;

    const session = this.getOrCreateSession(serial, domains);
    session.addConnection(serial, interfaceName, socket);

    for (const domain of domains) {
      this.activeRoutesByDomain.set(domain, session);
    }

    return true;
  }

  resolveByHost(hostHeader) {
    const domain = normalizeHost(hostHeader);
    if (!domain) return null;
    return this.activeRoutesByDomain.get(domain) || null;
  }
}
```

---

## ClientSession

Each connected certificate serial gets isolated state:

```js
class ClientSession {
  constructor({ serial, domains }) {
    this.serial = String(serial);
    this.domains = new Set(domains);
    this.pool = new ConnectionPool({ clientSerial: serial });
    this.nextStreamId = 1;
    this.activeStreams = new Map();
  }

  addConnection(serial, interfaceName, socket) {
    if (String(serial) !== this.serial) return false;
    return this.pool.add(serial, interfaceName, socket);
  }

  hasConnections() {
    return this.pool.count > 0;
  }
}
```

The existing `ConnectionPool` should become per-session. It should no longer enforce “only one client serial globally”; that enforcement moves to the manager/session boundary.

---

## TLS Server Changes

Current tunnel server receives an `INIT` frame and then registers the socket into the single global pool.

New flow:

1. Accept mTLS socket.
2. Read peer certificate.
3. Extract `serialNumber`.
4. Reject if revoked.
5. Extract authorized domains from cert SAN DNS entries.
6. Wait for `INIT` only for interface metadata, max frame size, optional client label, and optional requested domain subset.
7. Register socket with `MultiClientManager.addTunnelConnection(...)`.

`INIT` payload should become:

```json
{
  "clientId": "acme-macbook",
  "interface": "en0",
  "maxFrameSize": 1048576,
  "domains": ["acme.example.com"]
}
```

`domains` is optional. If present, it must be a subset of the certificate SAN domains.

This lets one certificate authorize multiple domains while one client process chooses to serve only a subset.

---

## HTTP Routing

For every public request:

```js
const route = multiClientManager.resolveByHost(req.headers.host);

if (!route) {
  res.statusCode = 404;
  res.end('Unknown tunnel domain');
  return;
}

const session = route.session;

if (!session.hasConnections()) {
  res.statusCode = 502;
  res.end(`Tunnel client not connected for ${route.domain}`);
  return;
}

const streamId = session.allocateStreamId();
session.registerStream(streamId, handlers);
session.send(frame);
```

HTTP error behavior:

| Condition | Status |
| --- | --- |
| Missing or invalid Host | `400 Bad Request` |
| Domain not present in issued cert index | `404 Not Found` |
| Domain authorized but no tunnel connected | `502 Bad Gateway` |
| Authorizing cert revoked | `404 Not Found` or `403 Forbidden` |
| Client max streams exceeded | `503 Service Unavailable` |

Prefer `404` for unauthorized/revoked domains if we do not want to disclose configured/issued domains.

---

## WebSocket Routing

The WebSocket upgrade path follows the same host-routing rules.

Before accepting the upgrade:

1. Normalize `Host`.
2. Resolve active client session.
3. Verify session has active tunnel connections.
4. Enforce per-client WebSocket stream limits.
5. Allocate stream ID inside that session.
6. Register stream handlers inside that session.
7. Send tunnel `UPGRADE` frame through that session's pool.

All WebSocket state must remain session-scoped.

---

## Caddy Dynamic HTTPS Design

Use Caddy On-Demand TLS with okproxy ask endpoint:

```caddy
{
    on_demand_tls {
        ask http://127.0.0.1:8080/_okproxy/caddy-ask
    }
}

https:// {
    tls {
        on_demand
    }

    reverse_proxy 127.0.0.1:8080
}
```

Ask endpoint behavior:

```text
GET /_okproxy/caddy-ask?domain=acme.example.com
```

Return `200` only if:

- Domain normalizes successfully.
- Domain appears in the issued domain index.
- At least one authorizing certificate serial is valid and not revoked.
- Optional policy checks pass.

Return non-2xx otherwise.

This lets Caddy issue/renew public HTTPS certificates dynamically without a static Caddyfile domain list.

Important distinction:

- Caddy's public certificate is for browsers.
- Okproxy client certificates are for mTLS tunnel authorization.
- They are separate certificate systems and must not be confused.

---

## Caddy Ask Source of Truth

There are two possible sources:

### Option A: Active connected sessions only

Allow a domain only if a client with a cert containing that domain is currently connected.

Pros:

- No extra CA index file needed.
- Very strict runtime behavior.

Cons:

- First browser request fails if Caddy needs to issue cert before the tunnel client connects.
- Renewal may fail if client is offline.
- Server restart loses active state until clients reconnect.

### Option B: CA issued domain index

Allow a domain if it appears in CA-issued metadata and its certificate is not revoked.

Pros:

- Caddy can issue/renew certificates even before the client reconnects.
- No hand-written config.
- Stable across server/client restarts.

Cons:

- Requires maintaining generated CA metadata.

Recommended v1: **Option B**.

---

## Request Metadata Forwarding

The server should include public routing metadata in `HEADERS` and `UPGRADE` frames so the client proxy can generate trusted forwarding headers.

Example frame payload:

```json
{
  "method": "GET",
  "path": "/dashboard",
  "headers": {},
  "clientSerial": "1",
  "publicHost": "acme.example.com",
  "publicProto": "https",
  "remoteAddress": "203.0.113.10"
}
```

Client proxy behavior:

```js
proxyHeaders['x-forwarded-for'] = reqInfo.remoteAddress;
proxyHeaders['x-forwarded-host'] = reqInfo.publicHost;
proxyHeaders['x-forwarded-proto'] = reqInfo.publicProto || 'https';
```

Security requirement:

- Strip user-supplied `x-forwarded-*` headers before adding trusted values.
- Do not forward internal routing metadata to target apps except through trusted headers.

---

## Host Header to Target

Default behavior should keep the target-oriented `Host` header:

```text
Host: localhost:3000
```

Add optional client behavior:

```bash
node apps/client/index.js \
  --server tunnel.example.com:9443 \
  --target localhost:3000 \
  --preserve-host
```

When enabled, the client forwards the original public host:

```text
Host: acme.example.com
```

Recommended v1 default: `preserveHost: false`, because it matches the current local-target model and avoids surprising local app behavior.

---

## Client CLI Changes

Client no longer needs to claim domains to gain authorization. Authorization comes from the certificate.

Basic command:

```bash
node apps/client/index.js \
  --server tunnel.example.com:9443 \
  --target localhost:3000 \
  --multipath
```

Optional diagnostics/subset mode:

```bash
node apps/client/index.js \
  --server tunnel.example.com:9443 \
  --target localhost:3000 \
  --domain acme.example.com \
  --multipath
```

If `--domain` is provided, the server verifies it is included in the certificate SAN DNS list. This is useful when one cert contains multiple domains but a process should serve only one subset.

---

## Server CLI Changes

Add:

```bash
--cert-bound-domains
--issued-domain-index /etc/okproxy/ca/issued-domains.json
--http-host 127.0.0.1
```

Example production command:

```bash
node apps/server/index.js \
  --http-host 127.0.0.1 \
  --http-port 8080 \
  --tls-port 9443 \
  --cert-bound-domains \
  --issued-domain-index /etc/okproxy/ca/issued-domains.json
```

Binding HTTP to loopback is recommended because public HTTPS should terminate at Caddy.

---

## Deployment Design

### DNS

Each public domain points to the same server IP:

```text
acme.example.com      A     <server-ip>
beta.example.com      A     <server-ip>
www.acme.example.com  A     <server-ip>
```

The tunnel host can also point to the same server IP:

```text
tunnel.example.com A <server-ip>
```

### Caddy

Use one dynamic catch-all HTTPS site with On-Demand TLS and ask endpoint. No per-domain Caddyfile edits are needed after issuing client certificates.

### Server files

Recommended files:

```text
/etc/okproxy/
  server.env
  ca-cert.pem
  ca/
    certs.json
    revoked.json
    issued-domains.json
```

### Client deployment

Use one deploy config per client certificate:

```bash
SERVER_HOST=tunnel.example.com:9443
TARGET_HOST=localhost:3000
CERT_DIR=./.certs/clients/acme
DEPLOY_HOST=user@acme-mac.local
```

Each client uses its own certificate/key pair.

---

## Certificate Rotation and Transfer

### Rotation for same client

1. Issue replacement cert with same domains.
2. Deploy replacement cert/key to client.
3. Restart client.
4. Revoke old serial.
5. Refresh issued domain index.

### Transfer domain to a different client

1. Revoke old certificate or issue new cert with explicit overlap mode.
2. Issue new cert for the new client containing the domain.
3. Deploy new cert to new client.
4. Restart/reload okproxy server if the CA index is not watched live.
5. Ensure old client can no longer connect for that domain.

The source of truth remains the CA, not a manually edited domain registry.

---

## Revocation

Revocation must affect both tunnel connections and Caddy ask responses.

When a serial is revoked:

- New tunnel connections using that serial are rejected.
- Existing sessions for that serial should be disconnected.
- Domains authorized only by that serial should be removed or marked inactive in the issued domain index.
- Caddy ask endpoint should return non-2xx for those domains unless another valid cert also authorizes them.

---

## Threat Model Notes

### Client tries to claim extra domain in INIT

Rejected or ignored because runtime domains must be a subset of certificate SAN DNS entries.

### Client key leaks

Attacker can impersonate only the leaked certificate and serve only its embedded domains. They cannot add new domains. Operator must revoke the leaked serial.

### Client cert contains too many domains

Leak blast radius includes every domain in that cert. Keep certs narrowly scoped.

### DNS points unknown domain to server

Caddy asks okproxy. Ask endpoint rejects because the domain is not in the issued domain index.

### Malicious Host header

HTTP router normalizes `Host` and resolves exact match only. Unknown domains return `404`.

### Duplicate valid certs for same domain

Fail closed unless explicit rotation overlap is implemented.

---

## Host Normalization

Apply the same normalization everywhere:

- Lowercase.
- Strip trailing dot.
- Strip port from HTTP `Host`.
- Convert internationalized domains to ASCII/punycode if supported.
- Reject empty labels.
- Reject invalid characters.
- Reject wildcard domains in v1.
- Exact match only.

Use one shared helper for:

- CA issue validation.
- Certificate domain extraction.
- Caddy ask endpoint.
- HTTP router.
- WebSocket router.
- Optional client `INIT` subset validation.

---

## Backwards Compatibility

If `--cert-bound-domains` is omitted:

- Keep current single-client behavior.
- Create one internal legacy session.
- Route all traffic to the single global/legacy pool.
- Preserve current “one active client serial” policy.

If `--cert-bound-domains` is enabled:

- Enable strict host routing.
- Reject unknown domains.
- Reject certs with no authorized domains.
- Do not trust client-provided domains for authorization.

---

## Implementation Plan

### Phase 1: CA updates

- Add `--domain` support to `issue-client`.
- Add SAN DNS entries to client certificates.
- Persist issued domain metadata.
- Update revoke flow to update/mark issued domain metadata.
- Add list output showing domains per cert.

### Phase 2: Certificate parsing

- Add helper to extract SAN DNS domains from peer certificate.
- Normalize domains with a shared helper.
- Reject invalid/no-domain certs in cert-bound mode.

### Phase 3: Multi-client runtime

- Add `ClientSession`.
- Add `MultiClientManager`.
- Make `ConnectionPool` session-scoped.
- Register active domain routes from certificate domains.

### Phase 4: HTTP/WebSocket routing

- Resolve `Host` to session.
- Route HTTP requests to selected session.
- Route WebSocket upgrades to selected session.
- Add proper `404`/`502`/`503` behavior.

### Phase 5: Caddy ask endpoint

- Add `/_okproxy/caddy-ask` internal endpoint.
- Check issued domain index and revocation state.
- Return `200` only for CA-authorized domains.
- Configure Caddy On-Demand TLS.

### Phase 6: Deployment docs/tests

- Update deployment scripts.
- Add tests for certificate SAN domain extraction.
- Add tests for duplicate domain issuance.
- Add tests for Caddy ask allow/deny behavior.
- Add E2E tests with two clients and two domains.

---

## Test Plan

### Unit tests

- Domain normalization.
- Invalid domain rejection.
- Client certificate SAN domain extraction.
- No-domain cert rejection in cert-bound mode.
- Duplicate domain issuance rejection.
- Revoked serial rejection.
- Caddy ask endpoint allow/deny.
- Optional `INIT` domain subset validation.

### E2E tests

- Two clients, two certificates, two domains:
  - `a.test` routes to target A.
  - `b.test` routes to target B.
- Client A cannot serve Client B's domain.
- Client-provided unlisted domain is rejected.
- Unknown domain returns `404`.
- Authorized domain with disconnected client returns `502`.
- WebSocket routing works per domain.
- Multipath works per certificate serial.
- Revoked cert cannot connect.
- Caddy ask rejects revoked/unknown domains.

---

## Recommended v1 Scope

Implement certificate-bound domain routing:

- `tunnel-ca issue-client --domain ...`
- client certificate SAN DNS domains as authorization source
- generated issued domain index for Caddy ask endpoint
- `--cert-bound-domains` server mode
- one runtime `ClientSession` per certificate serial
- exact domain matching only
- no runtime domain claiming
- HTTP and WebSocket routing by `Host`
- Caddy On-Demand TLS with okproxy ask endpoint
- revoke leaked certificates to remove authorization
- legacy single-client mode preserved when cert-bound mode is disabled

This gives dynamic multi-client support without hand-written routing config while keeping the security boundary simple: only the okproxy CA can authorize domains.

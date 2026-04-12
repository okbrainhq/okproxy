# Security Audit Report

Date: 2026-04-12

## Critical

### 1. Command Injection in `ca.js`

**Location:** `apps/server/lib/ca.js:151-158`

The `hostname` parameter is interpolated directly into a shell command via `execSync`:

```js
execSync(
  `openssl req -new -key "${serverKeyPath}" -out "${serverCsrPath}" -subj "/CN=${hostname}" ...`
);
```

A malicious hostname like `x" $(rm -rf /) "` could break out of the double quotes. While the `tunnel-ca.js` CLI is the main caller, if this is ever exposed to network input, it's RCE. **Use `execFileSync` or `execFile` with an args array** to avoid shell interpolation entirely.

---

## High

### 2. Response Header Injection from Tunnel Client

**Location:** `apps/server/lib/http-router.js:125-129`

The tunnel client's response headers are set on the public HTTP response without filtering:

```js
Object.entries(headers.headers).forEach(([k, v]) => {
  res.setHeader(k, v);
});
```

A compromised/malicious client can inject `Set-Cookie`, `Location`, `Content-Security-Policy`, `X-Frame-Options`, or even `Transfer-Encoding` headers on the public-facing response. **Filter/whitelist response headers** from the tunnel client.

### 3. Unvalidated Request Headers Forwarded

**Location:** `apps/server/lib/http-router.js:56-60`

All incoming public request headers (`req.headers`) are forwarded wholesale to the tunnel client. This includes `Transfer-Encoding`, `Content-Length`, `Connection`, etc. which can be manipulated to smuggle requests or confuse the local service. **Sanitize hop-by-hop and dangerous headers** before forwarding.

### 4. No Request Body Size Limit

**Location:** `apps/server/lib/http-router.js:67-73`

While individual frames are capped at 1MB, there is no limit on the total request body size across multiple DATA frames. An attacker can send arbitrarily large bodies to exhaust memory/bandwidth. **Add a configurable max body size** and abort when exceeded.

---

## Medium

### 5. CORS Misconfiguration

**Location:** `apps/server/lib/http-router.js:14-19`

```js
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

`Access-Control-Allow-Credentials: true` with `Origin: *` is invalid per spec (browsers block it), but this signals a misconfiguration. If anyone changes `*` to reflect the request origin, it would allow credential-based requests from any site. **Remove `Allow-Credentials`** since `*` is used, or implement an explicit origin whitelist.

### 7. Stream ID Wraparound Collision

**Location:** `apps/server/lib/tls-server.js:166-169`

```js
if (nextStreamId > 2147483647) nextStreamId = 1;
```

On wraparound, the new stream ID may collide with an active stream. There is no check for existing stream usage. **Check `activeStreams.has(id)` before returning**, or use a different allocation strategy.

### 8. Plaintext TCP Server Has No Auth

**Location:** `apps/server/lib/tcp-server.js`

The Phase 1 TCP server accepts connections with zero authentication. While TLS is the recommended path, if this server is accidentally exposed, anyone can connect and tunnel traffic. Consider **removing it from production codepaths** or adding a warning.

> Remove this totally. We don't need it

---

## Low

### 10. No Explicit TLS Minimum Version

**Location:** `apps/server/lib/tls-server.js:19-25`

The TLS server doesn't set `minVersion`. Modern Node.js defaults to TLS 1.2+, but **explicitly set `minVersion: 'TLSv1.2'`** for defense in depth.

### 11. Vim Swap File in Project Root

`.README.md.swp` exists in the project root. Swap files can contain editor buffers with potentially sensitive content. **Delete it.** The `.gitignore` already covers `*.swp`.

### 12. CA Tracking Files Have No Restricted Permissions

**Location:** `apps/server/lib/ca.js:34-36`

`crl.txt`, `issued.txt`, and `serial-counter.txt` are created with default file permissions. **Use `chmodSync` or `writeFileSync` with mode `0o600`** to restrict access.

### 13. Revocation Check is File-Based and Synchronous

**Location:** `apps/server/lib/ca.js:202-218`

`isRevoked` reads `crl.txt` synchronously on every TLS connection. Under high connection rates, this is a bottleneck and has a TOCTOU race with `revokeCertificate`. Consider an in-memory cache with file-based persistence.

### 14. CA Key Size is 2048-bit

**Location:** `apps/server/lib/ca.js:24`

2048-bit RSA is acceptable but 4096-bit is recommended for CA keys specifically, since they're long-lived (10 years).


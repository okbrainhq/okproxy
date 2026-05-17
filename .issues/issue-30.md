# Connection pool is not scoped by client certificate identity

**Severity:** Medium correctness issue under the current deployment model; high only if issued client certs belong to mutually untrusted parties or compromised devices.

**Status:** Fixed for the current single-active-client server model, with e2e regression coverage.

**Location:**
- `apps/server/lib/tls-server.js:116-128`
- `apps/server/lib/connection-pool.js:19-25`

The TLS server validates the client certificate and logs its serial number, but the shared `ConnectionPool` only keys connections by the client-supplied interface name:

```js
if (clientInit.interface) {
  interfaceName = clientInit.interface;
}

connectionPool.add(interfaceName, socket);
```

```js
add(interfaceName, socket) {
  if (this.connections.has(interfaceName)) {
    const old = this.connections.get(interfaceName);
    try { old.destroy(); } catch {}
  }
  this.connections.set(interfaceName, socket);
}
```

Any already-issued valid client certificate can choose an interface name such as `default` or `en0` and replace an existing connection for that interface. The current deployment reduces this risk because client certs are pre-issued and the CA private key is deleted, so attackers cannot mint new valid certs without a full redeploy. However, deletion of the CA private key does not isolate the certs that already exist.

**Impact:** a second already-issued tunnel client can disrupt or take over traffic for the currently connected client if both connect to the same server and present the same interface name. This is mostly an operational correctness problem when all cert holders are controlled by the same operator. It becomes a security issue if one issued cert is compromised, stale, or belongs to a device/operator that should not be able to affect another tunnel client.

**Suggested fix:** include the authenticated certificate serial in the pool key, or explicitly enforce a single authorized client identity. For example, register connections under `${serial}:${interfaceName}` and route public traffic only to the selected serial/client session.

Add e2e coverage with two issued client certificates:
- first client connects and serves traffic;
- second client connects using the same interface name;
- assert the first client is not silently replaced unless that is the intended policy.

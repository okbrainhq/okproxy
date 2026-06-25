const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { ConnectionPool } = require('./connection-pool');
const { extractAuthorizedDomains, normalizeDomains, normalizeHost } = require('./domain-utils');
const { isRevoked } = require('./ca');

class ClientSession {
  constructor({ serial, domains, maxStreams = 100 }) {
    this.serial = String(serial);
    this.domains = new Set(domains);
    this.pool = new ConnectionPool({ clientSerial: serial });
    this.nextStreamId = 1;
    this.activeStreamIds = new Set();
    this.maxStreams = maxStreams;
    this.activeWebSockets = new Set();
  }

  addConnection(serial, interfaceName, socket) {
    if (String(serial) !== this.serial) return false;
    return this.pool.add(serial, interfaceName, socket);
  }

  removeConnection(socket) {
    this.pool.remove(socket);
  }

  hasConnections() {
    return this.pool.count > 0;
  }

  allocateStreamId() {
    const attempts = this.maxStreams;
    for (let i = 0; i < attempts; i++) {
      const id = this.nextStreamId++;
      if (this.nextStreamId > 2147483647) this.nextStreamId = 1;
      if (!this.activeStreamIds.has(id)) {
        this.activeStreamIds.add(id);
        return id;
      }
    }
    throw new Error('No available stream IDs');
  }

  releaseStreamId(streamId) {
    this.activeStreamIds.delete(streamId);
  }
}

class MultiClientManager {
  constructor(options = {}) {
    this.caDir = options.caDir || './.ca';
    this.issuedDomainIndex = options.issuedDomainIndex;
    this.maxStreams = options.maxConcurrentStreams || 100;
    this.sessionsBySerial = new Map();
    this.activeRoutesByDomain = new Map();
    this.issuedDomains = new Map();
    this.reloadIssuedDomainIndex();
  }

  reloadIssuedDomainIndex() {
    this.issuedDomains.clear();
    if (!this.issuedDomainIndex || !existsSync(this.issuedDomainIndex)) return;
    const raw = JSON.parse(readFileSync(this.issuedDomainIndex, 'utf8'));
    for (const [domainValue, info] of Object.entries(raw.domains || {})) {
      const domain = normalizeHost(domainValue);
      if (!domain) continue;
      const serials = Array.isArray(info.serials) ? info.serials.map(String) : [];
      this.issuedDomains.set(domain, { serials, status: info.status || 'valid' });
    }
  }

  isIssuedDomain(domain) {
    const info = this.issuedDomains.get(domain);
    if (!info || info.status !== 'valid') return false;
    let revokedSerials = new Set();
    try {
      revokedSerials = new Set(readFileSync(join(this.caDir, 'crl.txt'), 'utf8').split('\n').filter(Boolean));
    } catch {}
    return info.serials.some(serial => !revokedSerials.has(String(serial)));
  }

  isAskAllowed(domainValue) {
    this.reloadIssuedDomainIndex();
    const domain = normalizeHost(domainValue);
    return Boolean(domain && this.isIssuedDomain(domain));
  }

  ensureIssuedDomains(serial, domains) {
    if (!this.issuedDomainIndex || domains.length === 0) return;

    let index = { version: 1, domains: {} };
    if (existsSync(this.issuedDomainIndex)) {
      try {
        const parsed = JSON.parse(readFileSync(this.issuedDomainIndex, 'utf8'));
        index = { version: parsed.version || 1, domains: parsed.domains || {} };
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to read issued domain index ${this.issuedDomainIndex}:`, err.message);
        return;
      }
    }

    let changed = false;
    // TLS exposes certificate serials as hex strings, while CA metadata/CRL use decimal.
    // Store decimal serials in issued-domains.json so revocation checks remain consistent.
    const serialString = String(parseInt(String(serial), 16));
    for (const domain of domains) {
      if (!index.domains[domain]) {
        index.domains[domain] = { serials: [], status: 'valid' };
        changed = true;
      }
      const info = index.domains[domain];
      if (!Array.isArray(info.serials)) {
        info.serials = [];
        changed = true;
      }
      if (!info.serials.includes(serialString)) {
        info.serials.push(serialString);
        changed = true;
      }
      if (info.status !== 'valid') {
        info.status = 'valid';
        changed = true;
      }
    }

    if (!changed) return;
    try {
      writeFileSync(this.issuedDomainIndex, JSON.stringify(index, null, 2) + '\n', { mode: 0o644 });
      this.reloadIssuedDomainIndex();
      console.log(`[${new Date().toISOString()}] Updated issued domain index for client ${serialString}: ${domains.join(', ')}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to update issued domain index ${this.issuedDomainIndex}:`, err.message);
    }
  }

  addTunnelConnection({ serial, cert, interfaceName, socket, requestedDomains }) {
    const serialString = String(serial);
    if (isRevoked(serialString, this.caDir)) return { ok: false, reason: 'revoked' };

    const certDomains = extractAuthorizedDomains(cert);
    if (certDomains.length === 0) return { ok: false, reason: 'no-authorized-domains' };

    let domains = certDomains;
    if (requestedDomains && requestedDomains.length > 0) {
      try {
        const requested = normalizeDomains(requestedDomains);
        const certSet = new Set(certDomains);
        const unauthorized = requested.find(domain => !certSet.has(domain));
        if (unauthorized) return { ok: false, reason: `unauthorized-domain:${unauthorized}` };
        domains = requested;
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    }

    for (const domain of domains) {
      const active = this.activeRoutesByDomain.get(domain);
      if (active && active.serial !== serialString && active.hasConnections()) {
        return { ok: false, reason: `domain-already-active:${domain}` };
      }
    }

    let session = this.sessionsBySerial.get(serialString);
    if (!session) {
      session = new ClientSession({ serial: serialString, domains, maxStreams: this.maxStreams });
      this.sessionsBySerial.set(serialString, session);
    } else {
      for (const domain of domains) session.domains.add(domain);
    }

    if (!session.addConnection(serialString, interfaceName, socket)) {
      return { ok: false, reason: 'session-rejected-connection' };
    }

    this.ensureIssuedDomains(serialString, domains);

    for (const domain of domains) {
      this.activeRoutesByDomain.set(domain, session);
    }

    return { ok: true, session, domains };
  }

  removeTunnelConnection(socket) {
    for (const session of this.sessionsBySerial.values()) {
      const before = session.pool.count;
      session.removeConnection(socket);
      if (before !== session.pool.count) {
        if (!session.hasConnections()) {
          for (const domain of session.domains) {
            if (this.activeRoutesByDomain.get(domain) === session) {
              this.activeRoutesByDomain.delete(domain);
            }
          }
          this.sessionsBySerial.delete(session.serial);
        }
        return;
      }
    }
  }

  resolveByHost(hostHeader) {
    const domain = normalizeHost(hostHeader);
    if (!domain) return { status: 'invalid-host', domain: null, session: null };

    const session = this.activeRoutesByDomain.get(domain) || null;
    if (session) return { status: 'active', domain, session };

    this.reloadIssuedDomainIndex();
    if (this.isIssuedDomain(domain)) return { status: 'disconnected', domain, session: null };

    return { status: 'unknown', domain, session: null };
  }
}

module.exports = { MultiClientManager, ClientSession };

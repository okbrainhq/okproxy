// Multi-client manager — certificate-bound domain routing for public traffic.
//
// Responsibilities:
//   * map authenticated client certificates (by serial) to tunnel sessions
//   * map authorized domains to the active session (resolveByHost)
//   * maintain the issued-domain index used by the Caddy ask endpoint
//
// Hardening notes (see docs/http-server-fixes.md):
//   * Metadata reads never throw. The routing hot path used to blow up on a
//     truncated/hand-edited issued-domains.json, which would surface as an
//     uncaught exception inside the HTTP request handler.
//   * Metadata writes are atomic (temp file + rename) so readers never observe
//     a partial document.
//   * If the index cannot be read, resolution fails closed (503) and the ask
//     endpoint denies (404) instead of routing traffic.
//   * Certificate revocation emits an in-process event (ca.js) and the manager
//     also exposes evictRevokedSessions()/startRevocationWatch() so callers can
//     evict sessions whose serials appear in the CRL.

const { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { join, resolve } = require('node:path');
const { ConnectionPool } = require('./connection-pool');
const { extractAuthorizedDomains, normalizeDomains, normalizeHost, normalizeDomain } = require('./domain-utils');
const { isRevoked, onCertificateRevoked, loadCertMetadata } = require('./ca');

const DEFAULT_REVOCATION_WATCH_INTERVAL_MS = 5000;
const INDEX_ERROR_LOG_INTERVAL_MS = 10000;

/**
 * Atomically persist a JSON metadata document (temp file + rename).
 * Rename is atomic on the same filesystem, so readers see either the previous
 * complete file or the new complete file — never a truncated one.
 */
function writeJsonAtomic(path, value, mode = 0o644) {
  const payload = JSON.stringify(value, null, 2) + '\n';
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempPath, payload, { mode });
    renameSync(tempPath, path);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Convert a certificate serial to its decimal string form.
 *
 * The codebase convention (see ca.isRevoked) is that TLS serials are uppercase
 * hex while metadata/CRL store decimal. Anything that is not hex-looking is
 * passed through unchanged so hand-built objects in tests keep working.
 */
function serialToDecimalString(value) {
  const serial = String(value === undefined || value === null ? '' : value).trim();
  if (!serial) return '';
  if (/^[0-9a-f]+$/i.test(serial)) return String(parseInt(serial, 16));
  return serial;
}

/** Read the CRL as a set of decimal serial strings. Never throws. */
function readRevokedSerials(caDir) {
  const revoked = new Set();
  try {
    const crl = readFileSync(join(caDir, 'crl.txt'), 'utf8');
    for (const line of crl.split('\n')) {
      const serial = line.trim();
      if (serial && /^\d+$/.test(serial)) revoked.add(serial);
    }
  } catch {
    // Missing/unreadable CRL -> nothing revoked (matches ca.isRevoked behavior).
  }
  return revoked;
}

class ClientSession {
  constructor({ serial, domains, maxStreams = 100 }) {
    this.serial = String(serial);
    this.domains = new Set(domains);
    this.pool = new ConnectionPool({ clientSerial: serial, maxTrackedStreams: maxStreams });
    this.nextStreamId = 1;
    this.activeStreamIds = new Set();
    this.maxStreams = maxStreams;
    this.activeWebSockets = new Set();
    this.evicted = false;
    this.evictedReason = null;
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
    if (this.evicted || this.activeStreamIds.size >= this.maxStreams || this.nextStreamId > 0x7fffffff) {
      throw new Error('Stream allocation limit (IDs never wrap)');
    }
    const id = this.nextStreamId++;
    this.activeStreamIds.add(id);
    return id;
  }

  releaseStreamId(streamId) {
    this.activeStreamIds.delete(streamId);
  }

  /**
   * Tear down the whole session: fail in-flight public streams, drop every
   * tunnel connection and release the transport state.
   *
   * Ordering matters. The manager removes the session from its maps right
   * after this call, so we must NOT rely on tls-server's async socket 'close'
   * handler (`removeTunnelConnection -> pool.remove`): by then the session is
   * no longer findable and the pool's connection entries plus every registered
   * stream handler would leak (public responses would hang forever).
   * Everything is therefore torn down here, synchronously, while the pool
   * still belongs to a live session.
   */
  evict(reason = 'session evicted') {
    this.evicted = true;
    this.evictedReason = reason;
    const pool = this.pool;
    if (!pool) return;

    // 1. Preferred transport hook (feature-detected; provided by the transport
    //    worker). It is expected to fail active streams and drop connections.
    if (typeof pool.evictAll === 'function') {
      try {
        pool.evictAll(reason);
      } catch (err) {
        console.error('Session pool.evictAll() failed:', err && err.message ? err.message : err);
      }
    }

    // 2. Synchronous connection removal. pool.remove() drops the connection
    //    entry and, once the last connection is gone, runs _cleanupAllStreams()
    //    which notifies every registered stream handler.
    for (const socket of [...pool.connections.values()]) {
      try {
        if (typeof pool.remove === 'function') pool.remove(socket);
      } catch (err) {
        console.error('Session pool.remove() failed:', err && err.message ? err.message : err);
      }
      try {
        if (socket && socket.destroyed !== true && typeof socket.destroy === 'function') socket.destroy();
      } catch { /* best-effort */ }
    }

    // 3. Belt and braces: if the pool still tracks stream handlers (e.g. a
    //    transport pool without remove()), terminate them explicitly so public
    //    responses fail instead of hanging, then drop the registries.
    this._terminateRemainingStreams(pool, reason);
    try { this.activeWebSockets.clear(); } catch { /* ignore */ }
  }

  /** Fail and drop any stream handler the pool still holds. */
  _terminateRemainingStreams(pool, reason) {
    if (!pool.activeStreams || pool.activeStreams.size === 0) return;
    for (const handlers of [...pool.activeStreams.values()]) {
      if (handlers && typeof handlers.errorHandler === 'function') {
        try {
          handlers.errorHandler(new Error(reason));
        } catch { /* a handler must never break eviction */ }
      }
    }
    try { pool.activeStreams.clear(); } catch { /* ignore */ }
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
    this.issuedIndexState = 'unknown'; // 'ok' | 'missing' | 'disabled' | 'error'
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.lastIndexErrorLogAt = 0;
    this.revocationWatchTimer = null;
    this.unsubscribeRevocation = null;

    this.reloadIssuedDomainIndex();
    this._subscribeToCertificateRevocation();

    if (options.revocationWatch) {
      this.startRevocationWatch(options.revocationWatchIntervalMs);
    }
  }

  _subscribeToCertificateRevocation() {
    this.unsubscribeRevocation = onCertificateRevoked((event) => {
      if (!event || typeof event.caDir !== 'string' || !event.caDir) return;
      // Compare normalized paths: the server may be configured with a relative
      // --ca-dir while a revocation caller passes an absolute one.
      let matches = false;
      try {
        matches = resolve(event.caDir) === resolve(this.caDir);
      } catch {
        matches = String(event.caDir) === String(this.caDir);
      }
      if (!matches) return;
      const revokedSerial = String(event.serial);
      const evicted = this.evictSessionsMatching(
        (session) => serialToDecimalString(session.serial) === revokedSerial
      );
      if (evicted > 0) {
        console.log(`[${new Date().toISOString()}] Evicted ${evicted} session(s) after revocation of serial ${revokedSerial}`);
      }
    });
  }

  _logIndexError(err) {
    const now = Date.now();
    if (now - this.lastIndexErrorLogAt < INDEX_ERROR_LOG_INTERVAL_MS) return;
    this.lastIndexErrorLogAt = now;
    console.error(`[${new Date().toISOString()}] Issued domain index ${this.issuedDomainIndex || '<unset>'} unavailable:`, err && err.message ? err.message : err);
  }

  /**
   * Reload the issued-domain index. Never throws; on failure the last good
   * snapshot is kept and `issuedIndexState` becomes 'error' so callers can
   * fail closed.
   * @returns {boolean} true when the index was read (or is unconfigured)
   */
  reloadIssuedDomainIndex() {
    if (!this.issuedDomainIndex) {
      this.issuedIndexState = 'disabled';
      return true;
    }

    let raw;
    try {
      if (!existsSync(this.issuedDomainIndex)) {
        this.issuedDomains = new Map();
        this.issuedIndexState = 'missing';
        return true;
      }
      raw = JSON.parse(readFileSync(this.issuedDomainIndex, 'utf8'));
    } catch (err) {
      this.issuedIndexState = 'error';
      this._logIndexError(err);
      return false;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.issuedIndexState = 'error';
      this._logIndexError(new Error('index root is not an object'));
      return false;
    }
    const rawDomains = raw.domains;
    if (rawDomains !== undefined && (rawDomains === null || typeof rawDomains !== 'object' || Array.isArray(rawDomains))) {
      this.issuedIndexState = 'error';
      this._logIndexError(new Error('index "domains" is not an object'));
      return false;
    }

    const next = new Map();
    for (const [domainValue, info] of Object.entries(rawDomains || {})) {
      const domain = normalizeHost(domainValue);
      if (!domain) continue;
      if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
      const serials = Array.isArray(info.serials)
        ? info.serials.map((value) => String(value).trim()).filter((value) => /^\d+$/.test(value))
        : [];
      const status = typeof info.status === 'string' && info.status ? info.status : 'valid';
      next.set(domain, { serials, status });
    }

    this.issuedDomains = next;
    this.issuedIndexState = 'ok';
    return true;
  }

  isIssuedDomain(domain) {
    const info = this.issuedDomains.get(domain);
    if (!info || info.status !== 'valid') return false;
    const revokedSerials = readRevokedSerials(this.caDir);
    if (revokedSerials.size === 0) return info.serials.length > 0;
    return info.serials.some((serial) => !revokedSerials.has(String(serial)));
  }

  isAskAllowed(domainValue) {
    try {
      this.reloadIssuedDomainIndex();
      if (this.issuedIndexState === 'error') return false; // fail closed
      const domain = normalizeHost(domainValue);
      if (!domain) return false;
      return this.isIssuedDomain(domain);
    } catch (err) {
      this._logIndexError(err);
      return false;
    }
  }

  /**
   * Rebuild issued-domains.json from certs.json. Recovery hook for a corrupt
   * index (the CLI/operator can also call this).
   */
  rebuildIndexFromCerts() {
    if (!this.issuedDomainIndex) return { ok: false, reason: 'no-index-configured' };
    const metadata = loadCertMetadata(this.caDir);
    const domains = {};
    for (const cert of metadata.certs || []) {
      if (cert.status !== 'valid') continue;
      const certDomains = Array.isArray(cert.domains) ? cert.domains : [];
      for (const domainValue of certDomains) {
        const domain = normalizeDomain(domainValue);
        if (!domain) continue;
        if (!domains[domain]) domains[domain] = { serials: [], status: 'valid' };
        const serial = String(cert.serial);
        if (!domains[domain].serials.includes(serial)) domains[domain].serials.push(serial);
      }
    }
    try {
      writeJsonAtomic(this.issuedDomainIndex, { version: 1, domains });
    } catch (err) {
      this._logIndexError(err);
      return { ok: false, reason: err.message };
    }
    this.reloadIssuedDomainIndex();
    return { ok: true, domains };
  }

  ensureIssuedDomains(serial, domains) {
    if (!this.issuedDomainIndex || domains.length === 0) return;

    let index = { version: 1, domains: {} };
    if (existsSync(this.issuedDomainIndex)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(this.issuedDomainIndex, 'utf8'));
      } catch (err) {
        // Fail closed: never clobber metadata we cannot parse.
        this._logIndexError(new Error(`refusing to overwrite unreadable index: ${err.message}`));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this._logIndexError(new Error('refusing to overwrite index with unexpected shape'));
        return;
      }
      const rawDomains = parsed.domains;
      if (rawDomains !== undefined && (rawDomains === null || typeof rawDomains !== 'object' || Array.isArray(rawDomains))) {
        this._logIndexError(new Error('refusing to overwrite index with unexpected "domains" shape'));
        return;
      }
      index = {
        version: Number.isFinite(parsed.version) ? parsed.version : 1,
        domains: { ...(rawDomains || {}) }
      };
    }

    let changed = false;
    // TLS exposes certificate serials as hex strings, while CA metadata/CRL use
    // decimal. Store decimal serials here so revocation checks stay consistent.
    const serialString = serialToDecimalString(serial);
    for (const domain of domains) {
      if (!index.domains[domain]) {
        index.domains[domain] = { serials: [], status: 'valid' };
        changed = true;
      }
      const info = index.domains[domain];
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        index.domains[domain] = { serials: [], status: 'valid' };
        changed = true;
      }
      const entry = index.domains[domain];
      if (!Array.isArray(entry.serials)) {
        entry.serials = [];
        changed = true;
      }
      if (!entry.serials.includes(serialString)) {
        entry.serials.push(serialString);
        changed = true;
      }
      if (entry.status !== 'valid') {
        entry.status = 'valid';
        changed = true;
      }
    }

    if (!changed) return;
    try {
      writeJsonAtomic(this.issuedDomainIndex, index, 0o644);
      this.reloadIssuedDomainIndex();
      console.log(`[${new Date().toISOString()}] Updated issued domain index for client ${serialString}: ${domains.join(', ')}`);
    } catch (err) {
      this._logIndexError(err);
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
    if (session && session.evicted) {
      this.sessionsBySerial.delete(serialString);
      session = null;
    }
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

    try {
      this.reloadIssuedDomainIndex();
      if (this.issuedIndexState === 'error') {
        return { status: 'metadata-error', domain, session: null };
      }
      if (this.isIssuedDomain(domain)) return { status: 'disconnected', domain, session: null };
    } catch (err) {
      this._logIndexError(err);
      return { status: 'metadata-error', domain, session: null };
    }

    return { status: 'unknown', domain, session: null };
  }

  /**
   * Evict every session matching the predicate. Returns the number evicted.
   * Emits `session-evicted` with `{ serial, domains, reason }`.
   */
  evictSessionsMatching(predicate) {
    let evicted = 0;
    for (const session of [...this.sessionsBySerial.values()]) {
      if (session.evicted) continue;
      if (!predicate(session)) continue;
      if (this._evictSession(session)) evicted++;
    }
    return evicted;
  }

  /** Evict sessions whose decimal serial is in the CRL (polling hook). */
  evictRevokedSessions() {
    const revokedSerials = readRevokedSerials(this.caDir);
    if (revokedSerials.size === 0) return 0;
    return this.evictSessionsMatching(
      (session) => revokedSerials.has(serialToDecimalString(session.serial))
    );
  }

  _evictSession(session, reason = 'certificate revoked') {
    if (session.evicted) return false;
    session.evicted = true;
    session.evictedReason = reason;

    // Tear down the transport FIRST, while this session is still registered in
    // sessionsBySerial. stream teardown must not depend on tls-server's async
    // socket 'close' handler, which can no longer find the session once it is
    // removed below (that ordering leaked pool connections and live streams).
    session.evict(reason);

    for (const domain of session.domains) {
      if (this.activeRoutesByDomain.get(domain) === session) {
        this.activeRoutesByDomain.delete(domain);
      }
    }
    this.sessionsBySerial.delete(session.serial);
    console.log(`[${new Date().toISOString()}] Session evicted (${reason}), serial: ${session.serial}, domains: ${[...session.domains].join(', ')}`);
    this.events.emit('session-evicted', {
      serial: session.serial,
      domains: [...session.domains],
      reason
    });
    return true;
  }

  /**
   * Poll the CRL and evict matching live sessions.
   *
   * Integration hook: tls-server.js should either call
   * `manager.evictRevokedSessions()` when it observes a CRL change or the
   * server entry point should construct the manager with
   * `{ revocationWatch: true }`. This change intentionally does not edit
   * tls-server.js.
   */
  startRevocationWatch(intervalMs = DEFAULT_REVOCATION_WATCH_INTERVAL_MS) {
    this.stopRevocationWatch();
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : DEFAULT_REVOCATION_WATCH_INTERVAL_MS;
    this.revocationWatchTimer = setInterval(() => {
      try {
        this.evictRevokedSessions();
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Revocation watch failed:`, err && err.message);
      }
    }, interval);
    if (typeof this.revocationWatchTimer.unref === 'function') this.revocationWatchTimer.unref();
    return () => this.stopRevocationWatch();
  }

  stopRevocationWatch() {
    if (this.revocationWatchTimer) {
      clearInterval(this.revocationWatchTimer);
      this.revocationWatchTimer = null;
    }
  }

  /** Release watchers/listeners. Call on shutdown or in tests. */
  dispose() {
    this.stopRevocationWatch();
    if (this.unsubscribeRevocation) {
      this.unsubscribeRevocation();
      this.unsubscribeRevocation = null;
    }
    this.events.removeAllListeners();
  }
}

module.exports = { MultiClientManager, ClientSession };

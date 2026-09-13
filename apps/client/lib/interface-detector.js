// InterfaceDetector — Detects internet-capable network interfaces via connectivity probe
// Replaces the old network-watchdog.js
//
// Design notes (stability):
// - Every candidate is probed every poll; the poll decision is built from the
//   *per-poll probe return values*, never reconstructed from a possibly-expired
//   cache entry (a slow sibling probe used to let cached entries expire and
//   silently drop a healthy interface).
// - The success cache records observations only and is cleared on failure,
//   so a stale IP (e.g. macOS EADDRNOTAVAIL after a tether drop) is
//   detected on the next poll instead of being served from cache forever.
// - Probe failures are tolerated for a bounded number of consecutive polls
//   (`failureTolerance`) so a single transient blip does not tear a lane down.
// - An interface that physically disappears from os.networkInterfaces() is
//   dropped immediately (no tolerance) and its cached state is forgotten.
// - stop() cancels in-flight probes and invalidates the poll run so a late
//   probe result can never emit 'change' after the detector was stopped.

const os = require('node:os');
const net = require('node:net');
const { EventEmitter } = require('node:events');

// Internal/virtual interfaces to always skip
const SKIP_PATTERNS = [
  /^lo\d*$/,
  /^awdl\d*$/,
  /^llw\d*$/,
  /^utun\d*$/,
  /^bridge\d*$/,
  /^vmenet\d*$/,
  /^anpi\d*$/,
  /^gif\d*$/,
  /^stf\d*$/,
  /^ap\d*/
];

function shouldSkip(name) {
  return SKIP_PATTERNS.some(p => p.test(name));
}

function normalizeNonNegative(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

class InterfaceDetector extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.serverHost - Tunnel server host
   * @param {number} options.serverPort - Tunnel server port
   * @param {number} options.pollInterval - Poll interval in ms (default: 2000)
   * @param {number} options.probeTimeout - Probe timeout in ms (default: 5000)
   * @param {number} options.cacheTTL - Probe success cache TTL in ms (default: 5000)
   * @param {number} options.failureTolerance - Consecutive probe failures tolerated (default: 2)
   * @param {number} options.maxProbeConcurrency - Max in-flight probes (default: 8)
   * @param {Function} options.networkInterfaces - Injectable os.networkInterfaces (tests)
   * @param {Function} options.createProbeSocket - Injectable net.Socket factory (tests)
   * @param {Function} options.now - Injectable clock (tests)
   */
  constructor(options = {}) {
    super();
    this.serverHost = options.serverHost || 'localhost';
    this.serverPort = options.serverPort || 9443;
    this.pollInterval = options.pollInterval || 2000;
    this.probeTimeout = options.probeTimeout || 5000;
    this.cacheTTL = options.cacheTTL || 5000;
    this.failureTolerance = normalizeNonNegative(options.failureTolerance, 2);
    this.maxProbeConcurrency = Math.max(1, normalizeNonNegative(options.maxProbeConcurrency, 8));
    this._networkInterfaces = options.networkInterfaces || (() => os.networkInterfaces());
    this._createProbeSocket = options.createProbeSocket || (() => new net.Socket());
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.timer = null;
    this.running = false;
    this._polling = false;
    this._runId = 0;
    this._pendingProbes = new Set();
    this.lastSet = null;
    this.cache = new Map(); // interfaceName -> { ip, expiresAt }
    this._stable = new Map(); // interfaceName -> { ip, failures }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._runId++;
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollInterval);
  }

  stop() {
    if (!this.running && this._pendingProbes.size === 0) {
      this._clearState();
      return;
    }
    this.running = false;
    this._runId++; // invalidate any in-flight poll/probe
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._cancelPendingProbes();
    this._clearState();
  }

  _clearState() {
    this._polling = false;
    this.cache.clear();
    this._stable.clear();
    this.lastSet = null;
  }

  _cancelPendingProbes() {
    for (const entry of [...this._pendingProbes]) {
      try { entry.done(false); } catch { /* ignore */ }
    }
    this._pendingProbes.clear();
  }

  _collectCandidates() {
    let interfaces;
    try {
      interfaces = this._networkInterfaces() || {};
    } catch {
      interfaces = {};
    }

    const candidates = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (shouldSkip(name)) continue;
      if (!Array.isArray(addrs)) continue;
      const ipv4 = addrs.find(a => a && a.family === 'IPv4' && !a.internal);
      if (!ipv4 || !ipv4.address || ipv4.address.startsWith('169.254.')) continue;
      candidates.push({ name, ip: ipv4.address });
    }
    return candidates;
  }

  _poll() {
    if (this._polling || !this.running) return;
    this._polling = true;
    const runId = this._runId;
    const candidates = this._collectCandidates();
    const presentNames = new Set(candidates.map(c => c.name));

    // Immediate physical disappearance: interfaces missing from the OS table are
    // dropped at once, without applying failure tolerance.
    for (const name of [...this._stable.keys()]) {
      if (!presentNames.has(name)) {
        this._stable.delete(name);
        this.cache.delete(name);
      }
    }

    this._probeAll(candidates, runId)
      .then(results => {
        if (runId !== this._runId || !this.running) return;
        this._applyResults(candidates, results);
      })
      .finally(() => {
        if (runId === this._runId) this._polling = false;
      });
  }

  _applyResults(candidates, results) {
    const active = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const prev = this._stable.get(candidate.name);

      if (results[i] === true) {
        this._stable.set(candidate.name, { ip: candidate.ip, failures: 0 });
        active.push({ name: candidate.name, ip: candidate.ip });
        continue;
      }

      // Probe failed. A newly seen interface never enters the stable set on a
      // failure; a known interface survives up to `failureTolerance` failures.
      if (prev && prev.ip === candidate.ip && prev.failures < this.failureTolerance) {
        prev.failures++;
        active.push({ name: candidate.name, ip: candidate.ip });
      } else {
        this._stable.delete(candidate.name);
        this.cache.delete(candidate.name);
      }
    }

    const key = JSON.stringify(active);
    if (this.lastSet !== key) {
      this.lastSet = key;
      this.emit('change', active);
    }
  }

  async _probeAll(candidates, runId) {
    const results = new Array(candidates.length).fill(false);
    let cursor = 0;
    const workerCount = Math.min(this.maxProbeConcurrency, candidates.length);

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= candidates.length) return;
        if (runId !== this._runId || !this.running) return;
        const candidate = candidates[index];
        results[index] = await this._probe(candidate.name, candidate.ip, runId);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  _probe(name, ip, runId) {
    return new Promise((resolve) => {
      if (runId !== undefined && runId !== this._runId) {
        resolve(false);
        return;
      }

      const sock = this._createProbeSocket();
      let settled = false;
      const entry = { sock, done: null };

      const done = (success) => {
        if (settled) return;
        settled = true;
        this._pendingProbes.delete(entry);
        try { sock.destroy(); } catch { /* ignore */ }
        // A late probe after stop()/restart must never influence state.
        if (runId !== undefined && runId !== this._runId) {
          resolve(false);
          return;
        }
        if (success) {
          this.cache.set(name, { ip, expiresAt: this._now() + this.cacheTTL });
        } else {
          this.cache.delete(name);
        }
        resolve(success);
      };

      entry.done = done;
      this._pendingProbes.add(entry);

      if (typeof sock.once === 'function') {
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
      }
      if (typeof sock.setTimeout === 'function') {
        sock.setTimeout(this.probeTimeout, () => done(false));
      }

      try {
        sock.connect({
          host: this.serverHost,
          port: this.serverPort,
          localAddress: ip
        });
      } catch {
        done(false);
      }
    });
  }
}

module.exports = { InterfaceDetector, shouldSkip };

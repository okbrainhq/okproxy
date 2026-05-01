// InterfaceDetector — Detects internet-capable network interfaces via connectivity probe
// Replaces the old network-watchdog.js

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

class InterfaceDetector extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.serverHost - Tunnel server host
   * @param {number} options.serverPort - Tunnel server port
   * @param {number} options.pollInterval - Poll interval in ms (default: 2000)
   * @param {number} options.probeTimeout - Probe timeout in ms (default: 2000)
   * @param {number} options.cacheTTL - Probe cache TTL in ms (default: 5000)
   */
  constructor(options = {}) {
    super();
    this.serverHost = options.serverHost || 'localhost';
    this.serverPort = options.serverPort || 9443;
    this.pollInterval = options.pollInterval || 2000;
    this.probeTimeout = options.probeTimeout || 2000;
    this.cacheTTL = options.cacheTTL || 5000;
    this.timer = null;
    this.running = false;
    this.lastSet = null;
    this.cache = new Map(); // interfaceName -> { ip, expiresAt }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollInterval);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cache.clear();
    this.lastSet = null;
  }

  _poll() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (shouldSkip(name)) continue;
      const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
      if (!ipv4 || ipv4.address.startsWith('169.254.')) continue;
      candidates.push({ name, ip: ipv4.address });
    }

    // Probe each candidate
    const probes = candidates.map(c => this._probe(c.name, c.ip));
    Promise.all(probes).then(() => {
      const active = [];
      for (const c of candidates) {
        const entry = this.cache.get(c.name);
        if (entry && entry.ip === c.ip && entry.expiresAt > Date.now()) {
          active.push({ name: c.name, ip: c.ip });
        }
      }

      const key = JSON.stringify(active);
      if (this.lastSet !== key) {
        this.lastSet = key;
        this.emit('change', active);
      }
    });
  }

  _probe(name, ip) {
    const cached = this.cache.get(name);
    if (cached && cached.ip === ip && cached.expiresAt > Date.now()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;

      const done = (success) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (success) {
          this.cache.set(name, { ip, expiresAt: Date.now() + this.cacheTTL });
        } else {
          this.cache.delete(name);
        }
        resolve(success);
      };

      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
      sock.setTimeout(this.probeTimeout, () => done(false));

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

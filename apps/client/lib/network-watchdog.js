// Network WatchDog - Fast network interface change detection
// Monitors os.networkInterfaces() and triggers callback when topology changes

const os = require('os');

/**
 * Generate a fingerprint of current network interfaces.
 * Returns a sorted, deterministic string of "interfaceName:ipv4Address" pairs.
 * Only includes non-internal IPv4 interfaces.
 */
function getNetworkFingerprint(ifaces = os.networkInterfaces()) {
  const active = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (ipv4) {
      active.push(`${name}:${ipv4.address}`);
    }
  }
  active.sort();
  return active.join(',');
}

/**
 * Network WatchDog - polls network interfaces and triggers callback on change
 */
class NetworkWatchDog {
  constructor(onChange, options = {}) {
    this.pollInterval = options.pollInterval || 200;
    this.onChange = onChange;
    this.lastFingerprint = null;
    this.lastFingerprintDetail = null;
    this.timer = null;
    this.running = false;
    this.pollCount = 0;
  }

  _log(msg) {
    console.log(`[network-watchdog] [${new Date().toISOString()}] ${msg}`);
  }

  /**
   * Get detailed interface information for logging
   */
  _getDetail() {
    const ifaces = os.networkInterfaces();
    const details = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          details.push({ name, address: a.address, netmask: a.netmask });
        }
      }
    }
    return details;
  }

  /**
   * Check current network state and trigger callback if changed
   */
  check() {
    this.pollCount++;
    const fp = getNetworkFingerprint();
    const detail = this._getDetail();

    // Periodic heartbeat every 30 polls (~6 seconds at 200ms interval, ~30s at 1000ms)
    if (this.pollCount % 30 === 0) {
      this._log(`periodic status: poll#${this.pollCount} fingerprint="${fp}" interfaces=${JSON.stringify(detail)}`);
    }

    // Detect change (but not on first poll when lastFingerprint is null)
    if (this.lastFingerprint !== null && fp !== this.lastFingerprint) {
      this._log(`NETWORK CHANGE DETECTED`);
      this._log(`  previous fingerprint: "${this.lastFingerprint}"`);
      this._log(`  current  fingerprint: "${fp}"`);
      this._log(`  previous interfaces: ${JSON.stringify(this.lastFingerprintDetail)}`);
      this._log(`  current  interfaces: ${JSON.stringify(detail)}`);
      this._log(`  poll #${this.pollCount}, interval=${this.pollInterval}ms`);
      this._log(`  triggering socket destroy for reconnection`);

      this.lastFingerprint = fp;
      this.lastFingerprintDetail = detail;
      this.onChange();
      return;
    }

    // Log initial fingerprint on first poll
    if (this.pollCount === 1) {
      this._log(`initial fingerprint: "${fp}" interfaces=${JSON.stringify(detail)}`);
    }

    this.lastFingerprint = fp;
    this.lastFingerprintDetail = detail;
  }

  /**
   * Start polling for network changes
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.pollCount = 0;

    this._log(`starting network watchdog (interval=${this.pollInterval}ms)`);

    // First check immediately
    this.check();
    // Then schedule periodic checks
    this.timer = setInterval(() => this.check(), this.pollInterval);
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    this._log(`stopping network watchdog after ${this.pollCount} polls`);

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.lastFingerprint = null;
    this.lastFingerprintDetail = null;
  }
}

module.exports = { NetworkWatchDog, getNetworkFingerprint };

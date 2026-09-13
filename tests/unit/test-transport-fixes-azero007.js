// Imported detector coverage retained; unsafe salvage/epoch assertions replaced.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { InterfaceDetector } = require('../../apps/client/lib/interface-detector');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
describe('InterfaceDetector stability', () => {
  function makeSocketFactory(behavior) {
    const sockets = [];
    return {
      sockets,
      create() {
        const sock = {
          handlers: {},
          destroyed: false,
          timeoutCb: null,
          once(ev, cb) { this.handlers[ev] = cb; },
          setTimeout(ms, cb) { this.timeoutCb = cb; },
          connect(opts) {
            const mode = behavior(opts.localAddress);
            if (mode === 'ok') setTimeout(() => this.handlers.connect && this.handlers.connect(), opts.delay || 0);
            else if (mode === 'fail') setTimeout(() => this.handlers.error && this.handlers.error(new Error('probe failed')), 0);
            // 'pending' never settles by itself
          },
          destroy() { this.destroyed = true; },
          settle(ev) { if (this.handlers[ev]) this.handlers[ev](new Error('late')); }
        };
        sockets.push(sock);
        return sock;
      }
    };
  }

  function ifaces(list) {
    const out = {};
    for (const [name, address] of list) out[name] = [{ family: 'IPv4', address, internal: false }];
    return out;
  }

  it('keeps a healthy interface even when a sibling probe is slow (no cached expiry drop)', async () => {
    const factory = makeSocketFactory(ip => (ip === '10.0.0.2' ? 'ok' : 'ok'));
    // Make the sibling slow by delaying its connect handler for the first IP.
    const original = factory.create.bind(factory);
    factory.create = () => {
      const sock = original();
      const originalConnect = sock.connect.bind(sock);
      sock.connect = (opts) => {
        if (opts.localAddress === '10.0.0.1') {
          setTimeout(() => sock.handlers.connect && sock.handlers.connect(), 120);
          return;
        }
        originalConnect(opts);
      };
      return sock;
    };

    const detector = new InterfaceDetector({
      serverHost: 'srv',
      serverPort: 1,
      pollInterval: 100000,
      probeTimeout: 1000,
      cacheTTL: 1, // expired before the slow sibling resolves
      failureTolerance: 0,
      networkInterfaces: () => ifaces([['en0', '10.0.0.1'], ['en1', '10.0.0.2']]),
      createProbeSocket: factory.create
    });

    const changes = [];
    detector.on('change', active => changes.push(active));
    detector.start();
    await delay(300);
    detector.stop();

    const last = changes[changes.length - 1];
    assert.ok(last, 'a change was emitted');
    const names = last.map(i => i.name).sort();
    assert.deepStrictEqual(names, ['en0', 'en1'], 'both healthy interfaces survive a slow sibling');
  });

  it('tolerates bounded transient failures then removes the interface', async () => {
    let mode = 'ok';
    const factory = makeSocketFactory(() => mode);
    const detector = new InterfaceDetector({
      serverHost: 'srv',
      serverPort: 1,
      pollInterval: 100000,
      probeTimeout: 1000,
      cacheTTL: 5000,
      failureTolerance: 2,
      networkInterfaces: () => ifaces([['en0', '10.0.0.1']]),
      createProbeSocket: factory.create
    });

    const changes = [];
    detector.on('change', active => changes.push(active));
    detector.start();
    await delay(30);
    assert.strictEqual(changes[changes.length - 1].length, 1, 'healthy interface active');

    mode = 'fail';
    detector._poll();
    await delay(30);
    assert.strictEqual(changes[changes.length - 1].length, 1, 'first transient failure tolerated');
    detector._poll();
    await delay(30);
    assert.strictEqual(changes[changes.length - 1].length, 1, 'second transient failure tolerated');
    detector._poll();
    await delay(30);
    detector.stop();
    assert.strictEqual(changes[changes.length - 1].length, 0, 'third consecutive failure removes the interface');
  });

  it('removes a physically disappeared interface immediately', async () => {
    let present = true;
    const factory = makeSocketFactory(() => 'ok');
    const detector = new InterfaceDetector({
      serverHost: 'srv',
      serverPort: 1,
      pollInterval: 100000,
      failureTolerance: 5,
      networkInterfaces: () => (present ? ifaces([['en0', '10.0.0.1']]) : {}),
      createProbeSocket: factory.create
    });

    const changes = [];
    detector.on('change', active => changes.push(active));
    detector.start();
    await delay(30);
    assert.strictEqual(changes[changes.length - 1].length, 1);

    present = false;
    detector._poll();
    await delay(30);
    detector.stop();
    assert.strictEqual(changes[changes.length - 1].length, 0, 'disappearance bypasses failure tolerance');
  });

  it('cancels in-flight probes on stop and never emits afterwards', async () => {
    const factory = makeSocketFactory(() => 'pending');
    const detector = new InterfaceDetector({
      serverHost: 'srv',
      serverPort: 1,
      pollInterval: 100000,
      probeTimeout: 1000,
      networkInterfaces: () => ifaces([['en0', '10.0.0.1']]),
      createProbeSocket: factory.create
    });

    const changes = [];
    detector.on('change', active => changes.push(active));
    detector.start();
    assert.ok(factory.sockets.length >= 1, 'probe started');
    detector.stop();

    // Late probe settlements must not produce changes.
    for (const sock of factory.sockets) {
      sock.settle('connect');
      sock.settle('error');
    }
    await delay(40);
    assert.strictEqual(changes.length, 0, 'no change emitted after stop');
  });
});


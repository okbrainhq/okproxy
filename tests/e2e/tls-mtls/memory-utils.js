// Memory measurement helpers for the TLS e2e suite.
//
// heapUsed alone is a poor proxy for tunnel memory behaviour: frames are copied
// through Buffers, so growth shows up in `arrayBuffers` (native buffer bytes)
// and in RSS before the GC accounts for it on the JS heap. These helpers sample
// RSS, external and arrayBuffers so tests can assert on peak usage instead of a
// single after-the-fact heap delta.

function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers
  };
}

/**
 * Sample process memory on an interval and track peaks until stop() is called.
 * The sampling timer is unref'ed so it never keeps a test process alive.
 */
function startPeakSampler(intervalMs = 25) {
  let peakRss = 0;
  let peakArrayBuffers = 0;
  let peakExternal = 0;
  let peakHeapUsed = 0;
  let samples = 0;

  const sample = () => {
    const m = process.memoryUsage();
    samples += 1;
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.arrayBuffers > peakArrayBuffers) peakArrayBuffers = m.arrayBuffers;
    if (m.external > peakExternal) peakExternal = m.external;
    if (m.heapUsed > peakHeapUsed) peakHeapUsed = m.heapUsed;
  };

  sample();
  const timer = setInterval(sample, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      return { peakRss, peakArrayBuffers, peakExternal, peakHeapUsed, samples };
    }
  };
}

/** Format a byte delta for readable assertion messages. */
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = { memorySnapshot, startPeakSampler, mb };

# O(n²) buffer growth on WS reassembly path

**Severity:** Performance
**Location:** `apps/server/lib/http-router.js:513`, `apps/client/lib/proxy.js:145`

```js
targetToBrowserBuffer = Buffer.concat([targetToBrowserBuffer, frame.payload]);
```

Every incoming DATA frame triggers `Buffer.concat()`, which allocates a new buffer and copies all existing data plus the new chunk. Under high throughput (e.g., binary streaming at 10MB/s), this is O(n²) in total bytes copied — each new chunk copies all previously buffered bytes.

The frame protocol decoder (`packages/frame-protocol/index.js`) already uses a smarter pattern: it only concatenates when needed and reads directly from the buffer otherwise.

**Fix:** Use a chunk list (array of Buffers) to accumulate data, only concat when parsing needs to read across chunk boundaries. Alternatively, use a single pre-allocated buffer with read/write pointers (ring buffer).

Example chunk-list approach:
```js
let chunks = [];
let totalLen = 0;

// On data:
chunks.push(frame.payload);
totalLen += frame.payload.length;

// When parsing needed:
const buf = Buffer.concat(chunks);
chunks = [buf];
// ... parse from buf ...
```

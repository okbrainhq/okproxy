# Off-by-4 in full-unmask path

**Severity:** Bug (currently latent)
**Location:** `apps/client/lib/proxy.js:429`, `apps/server/lib/http-router.js:154`, `packages/frame-protocol/websocket.js:52-53`

`buffer.subarray(offset - (masked ? 4 : 0), frameSize)` includes the 4 mask-key bytes at the start of `payload`. The unmask loop then XORs starting at byte 0, so the first 4 bytes of actual payload are never unmasked and the mask bytes themselves get zeroed.

Not exercised today because every caller passes `boundariesOnly=true`, but the function is exported and the shared module advertises it.

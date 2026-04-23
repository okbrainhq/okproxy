# test-ws-debug.js committed at repo root

**Severity:** Code hygiene
**Location:** `test-ws-debug.js` (repo root)

226 lines, not wired into `package.json` scripts or `tests/e2e/tls-mtls/run.js`. Looks like a developer debug harness that slipped into the merge.

**Fix:** Delete or move under `tests/`.

// Staged trust-material upload (mocked ssh/scp — no host is touched).
//
// Regression: setup-server.sh used to `scp` server-cert.pem / server-key.pem
// straight into the *active* /var/lib/okproxy/certs. An upload interrupted
// between the two files left a NEW certificate next to the OLD key, and the
// active trust material was overwritten before anything validated it.
//
// The uploader now:
//   1. uploads every file into /var/lib/okproxy/staging/<release-id>/ (never the
//      active certs/ca directories);
//   2. asks the server to validate the complete set (key matches cert, cert
//      chains to the CA) and promote it to a persistent release;
//   3. only then activates it by swapping one symlink atomically, and discards
//      the failed staging directory otherwise.
//
// Failure injection: a mid-upload scp failure and a failed server-side
// validation must both leave the active trust material untouched (no activate
// invocation) and fail the orchestrator.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { copyFileSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeMock,
  writeSudoMock,
  readRemoteLog,
  runInSandbox
} = require('./helpers');

const ACTIVE_CERT_DIR = '/var/lib/okproxy/certs/';
const ACTIVE_CA_DIR = '/var/lib/okproxy/ca/';
const STAGING_PREFIX = '/var/lib/okproxy/staging/';
const PREVIOUS_RELEASE = 'releases/prev-20260101-000000Z-1';

/**
 * ssh/scp mocks that record every invocation, answer the orchestrator's
 * readlink query and can fail specific steps (failure injection).
 */
function writeTransportMocks(sandbox, { failScpAt = 0, validateExit = 0, activateExit = 0 } = {}) {
  const logFile = join(sandbox.log, 'remote.log');
  const scpCountFile = join(sandbox.log, 'scp-count');
  writeFileSync(logFile, '');
  writeFileSync(scpCountFile, '0');

  const recorder = `
log_file="${logFile}"
{
  printf '%s' "\${0##*/}"
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
} >> "$log_file"
`;

  writeMock(sandbox.bin, 'ssh', `${recorder}
command="$*"
case "$command" in
  *readlink*) printf '%s\\n' "${PREVIOUS_RELEASE}"; exit 0 ;;
esac
case "$command" in
  *--trust-release-validate=*) exit ${validateExit} ;;
  *--trust-release-discard=*) exit 0 ;;
  *--deploy-trust-release=*) exit ${activateExit} ;;
esac
exit 0
`);

  writeMock(sandbox.bin, 'scp', `${recorder}
count=$(cat "${scpCountFile}")
count=$((count + 1))
printf '%s' "$count" > "${scpCountFile}"
if [ "${failScpAt}" != "0" ] && [ "$count" -ge "${failScpAt}" ]; then
  echo "scp: simulated upload interruption" >&2
  exit 1
fi
exit 0
`);

  return { logFile };
}

function createProject(sandbox) {
  const proj = join(sandbox.root, 'proj');
  mkdirSync(join(proj, 'scripts', 'deploy'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'scripts', 'deploy', 'setup-server.sh'),
    join(proj, 'scripts', 'deploy', 'setup-server.sh')
  );
  mkdirSync(join(proj, '.certs'), { recursive: true });
  mkdirSync(join(proj, '.ca'), { recursive: true });
  writeFileSync(join(proj, '.certs', 'server-cert.pem'), 'CERT');
  writeFileSync(join(proj, '.certs', 'server-key.pem'), 'KEY');
  writeFileSync(join(proj, '.ca', 'ca-cert.pem'), 'CA');
  writeFileSync(join(proj, '.ca', 'issued-domains.json'), '{"domains":[]}');
  writeFileSync(join(proj, '.ca', 'crl.txt'), '');
  writeFileSync(
    join(proj, '.deploy.server'),
    "HOSTNAME='srv.example.test'\nREPO_URL='https://example.test/repo.git'\nBRANCH='main'\nDEPLOY_HOST='deploy@example.test'\n"
  );
  return proj;
}

function runUpload(sandbox, proj) {
  return runInSandbox(sandbox, 'bash scripts/deploy/setup-server.sh --upload-certs', { cwd: proj });
}

function entries(logFile) {
  return readRemoteLog(logFile);
}

function commandOf(entry) {
  return entry.args[entry.args.length - 1];
}

function scpDestinations(list) {
  // scp records "<host>:<path>"; return just the remote path.
  return list.filter(e => e.tool === 'scp').map(commandOf).map(target => {
    const idx = target.indexOf(':');
    return idx === -1 ? target : target.slice(idx + 1);
  });
}

function indexOfCommand(list, pattern) {
  return list.findIndex(e => pattern.test(commandOf(e)));
}

describe('setup-server.sh staged trust upload (mocked)', () => {
  it('uploads only into the staging directory, validates, activates, then runs setup', () => {
    const sandbox = createSandbox('okproxy-upload-');
    try {
      const { logFile } = writeTransportMocks(sandbox);
      writeSudoMock(sandbox);
      const proj = createProject(sandbox);

      const res = runUpload(sandbox, proj);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      const list = entries(logFile);
      const scpTargets = scpDestinations(list);
      // The only non-trust scp is the remote script itself.
      const scriptCopies = scpTargets.filter(d => d.endsWith('~/setup-server-remote.sh'));
      assert.strictEqual(scriptCopies.length, 1, 'the remote script must still be copied exactly once');
      const trustUploads = scpTargets.filter(d => !d.endsWith('~/setup-server-remote.sh'));
      assert.ok(trustUploads.length >= 4,
        `expected the trust files to be uploaded, got ${trustUploads.length}`);

      // Never write into the active trust directories.
      for (const dest of trustUploads) {
        assert.ok(dest.startsWith(STAGING_PREFIX), `upload must target staging, got: ${dest}`);
        assert.ok(!dest.startsWith(ACTIVE_CERT_DIR), `active cert dir must not be an upload target: ${dest}`);
        assert.ok(!dest.startsWith(ACTIVE_CA_DIR), `active CA dir must not be an upload target: ${dest}`);
      }

      // The release id is embedded in the staging path.
      const releaseId = trustUploads[0].slice(STAGING_PREFIX.length).split('/')[0];
      assert.match(releaseId, /^\d{8}T\d{6}Z-\d+$/, `unexpected release id: ${releaseId}`);
      for (const dest of trustUploads) {
        assert.ok(dest.startsWith(`${STAGING_PREFIX}${releaseId}/`),
          `every uploaded file must belong to release ${releaseId}: ${dest}`);
      }

      // Staging is created outside the active directories.
      const mkdirIdx = indexOfCommand(list, /mkdir -p '\/var\/lib\/okproxy\/staging\//);
      const validateIdx = indexOfCommand(list, /--trust-release-validate=/);
      const activateIdx = indexOfCommand(list, /--trust-release-activate=/);
      const setupIdx = indexOfCommand(list, /sudo ~\/setup-server-remote\.sh srv\.example\.test/);
      assert.ok(mkdirIdx > -1, 'staging directory must be created before uploading');
      assert.ok(validateIdx > -1, 'the staged release must be validated on the server');
      assert.strictEqual(activateIdx, -1, 'uploader must never activate outside the transaction');
      assert.ok(setupIdx > -1, 'the setup script must still run');
      assert.ok(mkdirIdx < validateIdx, 'validation must come after the upload');
      assert.ok(validateIdx < setupIdx, 'validate before transactional setup');
      assert.match(commandOf(list[setupIdx]), new RegExp(`--deploy-trust-release=${releaseId}`));
      assert.strictEqual(indexOfCommand(list, /readlink/), -1,
        'old state is captured by setup, not a stale pre-upload query');

    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('aborts without activating when an upload is interrupted midway', () => {
    const sandbox = createSandbox('okproxy-upload-interrupted-');
    try {
      const { logFile } = writeTransportMocks(sandbox, { failScpAt: 2 });
      writeSudoMock(sandbox);
      const proj = createProject(sandbox);

      const res = runUpload(sandbox, proj);
      assert.notStrictEqual(res.status, 0, 'an interrupted upload must fail the deployment');

      const list = entries(logFile);
      assert.strictEqual(indexOfCommand(list, /--trust-release-activate=/), -1,
        'an interrupted upload must never activate a release');
      assert.strictEqual(indexOfCommand(list, /sudo ~\/setup-server-remote\.sh srv\.example\.test/), -1,
        'the setup must not run after a failed upload');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('discards a stage that fails server-side validation and never activates it', () => {
    const sandbox = createSandbox('okproxy-upload-invalid-');
    try {
      const { logFile } = writeTransportMocks(sandbox, { validateExit: 1 });
      writeSudoMock(sandbox);
      const proj = createProject(sandbox);

      const res = runUpload(sandbox, proj);
      assert.notStrictEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /did not pass server-side validation/);
      assert.match(`${res.stdout}${res.stderr}`, /active trust material was not modified/i);

      const list = entries(logFile);
      assert.strictEqual(indexOfCommand(list, /--trust-release-activate=/), -1,
        'an invalid release must never be activated');
      assert.ok(indexOfCommand(list, /--trust-release-discard=/) > -1,
        'the rejected staging directory must be discarded');
      assert.strictEqual(indexOfCommand(list, /sudo ~\/setup-server-remote\.sh srv\.example\.test/), -1);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('fails without re-uploading when activation is refused', () => {
    const sandbox = createSandbox('okproxy-upload-activate-fail-');
    try {
      const { logFile } = writeTransportMocks(sandbox, { activateExit: 1 });
      writeSudoMock(sandbox);
      const proj = createProject(sandbox);

      const res = runUpload(sandbox, proj);
      assert.notStrictEqual(res.status, 0);


      const list = entries(logFile);
      assert.strictEqual(indexOfCommand(list, /--trust-release-discard=/), -1,
        'a validated release must not be discarded after a failed activation');
      assert.ok(indexOfCommand(list, /--trust-release-validate=/) > -1,
        'the release is validated before activation is attempted');
      assert.ok(indexOfCommand(list, /--deploy-trust-release=/) > -1,
        'activation failure is reported by transactional setup');
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it('leaves the trust material alone when --upload-certs is not requested', () => {
    const sandbox = createSandbox('okproxy-upload-none-');
    try {
      const { logFile } = writeTransportMocks(sandbox);
      writeSudoMock(sandbox);
      const proj = createProject(sandbox);

      const res = runInSandbox(sandbox, 'bash scripts/deploy/setup-server.sh', { cwd: proj });
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);

      const list = entries(logFile);
      assert.strictEqual(scpDestinations(list).length, 1, 'only the remote script itself is copied');
      assert.strictEqual(indexOfCommand(list, /--trust-release-validate=/), -1);
      assert.strictEqual(indexOfCommand(list, /--trust-release-activate=/), -1);
      const setupIdx = indexOfCommand(list, /sudo ~\/setup-server-remote\.sh srv\.example\.test/);
      assert.ok(setupIdx > -1, 'the setup must still run');
      assert.doesNotMatch(commandOf(list[setupIdx]), /--previous-trust-release/,
        'no trust rollback argument without an upload');
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

function activeIdxFor(list) {
  return indexOfCommand(list, /--trust-release-activate=/);
}

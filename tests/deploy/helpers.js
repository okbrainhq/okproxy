// Shared helpers for the disposable/mocked deployment validation suite.
//
// These tests never touch the host: every deployment script runs inside a
// throwaway temp sandbox with a mock PATH (ssh/scp/sudo/systemctl/loginctl).
// Nothing is installed, no service is started, no firewall is configured.

const {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync
} = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Create an isolated sandbox with bin/, home/ and log/ directories.
 */
function createSandbox(prefix = 'okproxy-deploy-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const sandbox = {
    root,
    bin: join(root, 'bin'),
    home: join(root, 'home'),
    log: join(root, 'log')
  };
  for (const dir of [sandbox.bin, sandbox.home, sandbox.log]) {
    mkdirSync(dir, { recursive: true });
  }
  // Default deny: a forgotten mock must never reach real service/network tools.
  for (const tool of ['sudo', 'systemctl', 'journalctl', 'ssh', 'scp', 'rsync', 'sftp']) {
    writeMock(sandbox.bin, tool, `echo "BLOCKED unmocked ${tool}" >&2; exit 111`);
  }
  return sandbox;
}

function cleanupSandbox(sandbox) {
  try {
    rmSync(sandbox.root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Write an executable mock script into the sandbox bin directory. */
function writeMock(binDir, name, body) {
  const file = join(binDir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * Mock ssh/scp that records each invocation (tab-separated args, one call per
 * line) and answers the one query the deploy scripts make: the remote $HOME.
 */
function writeRemoteMocks(sandbox, { remoteHome = '/home/tester' } = {}) {
  const logFile = join(sandbox.log, 'remote.log');
  writeFileSync(logFile, '');

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
case "$*" in
  *'printf %s "$HOME"'*|*"printf %s \\$HOME"*)
    printf '%s\\n' "${remoteHome}"
    ;;
esac
exit 0
`);

  writeMock(sandbox.bin, 'scp', `${recorder}
exit 0
`);

  return { logFile, remoteHome };
}

/**
 * Mock sudo: accepts "sudo -n true" and otherwise executes the command.
 */
function writeSudoMock(sandbox) {
  return writeMock(sandbox.bin, 'sudo', `
if [ "$1" = "-n" ] && [ "$2" = "true" ]; then
  exit 0
fi
exec "$@"
`);
}

/**
 * Mock systemctl for the client/server installer tests. Emulates just enough
 * state to drive restart/readiness checks.
 *
 * MOCK_SYSTEMCTL_MODE=ok          -> restart appends a fresh tunnel-connected log line
 * MOCK_SYSTEMCTL_MODE=fail        -> restart changes the invocation but logs nothing
 * MOCK_SYSTEMCTL_MODE=restart-fail -> restart itself fails (exit 1)
 *
 * When `healthFile` is passed, a successful restart also creates it and a failed
 * restart removes it, so a mocked readiness probe (e.g. curl) can be driven by
 * restart state instead of the host.
 */
function writeSystemctlMock(sandbox, { stateDir, logFile, healthFile }) {
  const state = stateDir || join(sandbox.log, 'systemctl-state');
  mkdirSync(state, { recursive: true });
  const health = healthFile || '';
  const file = writeMock(sandbox.bin, 'systemctl', `
mode="\${MOCK_SYSTEMCTL_MODE:-ok}"
state_dir="${state}"
log_file="${logFile}"
health_file="${health}"

args=("$@")
if [ "\${args[0]}" = "--user" ]; then
  args=("\${args[@]:1}")
fi

cmd="\${args[0]:-}"
echo \"$*\" >> \"$state_dir/calls.log\"
name="\${args[\${#args[@]}-1]:-}"

case "$cmd" in
  daemon-reload)
    if [ "$mode" = "daemon-fail" ] && [ ! -f "$state_dir/reload-failed" ]; then
      touch "$state_dir/reload-failed"; exit 1
    fi
    exit 0
    ;;
  enable)
    touch "$state_dir/enabled"
    exit 0
    ;;
  show)
    if [[ "$*" == *MainPID* ]]; then echo 4242; exit 0; fi
    if [ -f "$state_dir/invocation" ]; then
      cat "$state_dir/invocation"
    fi
    printf '\\n'
    exit 0
    ;;
  is-active)
    if [ -f "$state_dir/active" ]; then exit 0; else exit 1; fi
    ;;
  restart)
    if [ "$mode" = "restart-fail" ]; then
      [ -n "$health_file" ] && rm -f "$health_file"
      exit 1
    fi
    printf 'inv-%s' "$(date +%s%N)" > "$state_dir/invocation"
    touch "$state_dir/active"
    if [ "$mode" = "ok" ]; then
      [ -n "$health_file" ] && touch "$health_file"
      mkdir -p "$(dirname "$log_file")"
      printf 'Connected to TLS tunnel server\\n' >> "$log_file"
    else
      [ -n "$health_file" ] && rm -f "$health_file"
    fi
    exit 0
    ;;
  stop)
    rm -f "$state_dir/active"
    [ -n "$health_file" ] && rm -f "$health_file"
    exit 0
    ;;
  disable)
    rm -f "$state_dir/enabled"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
  return { file, state };
}

/** Mock journalctl: always succeeds, so rollback diagnostics never touch the host. */
function writeJournalctlMock(sandbox) {
  return writeMock(sandbox.bin, 'journalctl', 'exit 0');
}

function writeLoginctlMock(sandbox) {
  return writeMock(sandbox.bin, 'loginctl', 'exit 0');
}

/** Read the recorded remote invocations (one per line, tab separated). */
function readRemoteLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      return { tool: parts.shift(), args: parts };
    });
}

/**
 * Run a shell command inside the sandbox environment (mock PATH first, HOME
 * redirected, MOCK_* variables exported).
 */
function runInSandbox(sandbox, command, { env = {}, cwd } = {}) {
  return spawnSync('bash', ['-c', command], {
    cwd: cwd || sandbox.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandbox.home,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      MOCK_LOG: join(sandbox.log, 'remote.log'),
      ...env
    }
  });
}

/**
 * Execute a captured remote command locally against stubs, to prove that the
 * quoting produced by the orchestrator cannot be interpreted as shell syntax.
 * The stubbed remote script records the arguments it really received.
 */
function executeCapturedRemoteCommand(sandbox, command, { scriptName, argLogFile }) {
  const stubPath = join(sandbox.home, scriptName);
  writeFileSync(stubPath, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argLogFile}"\n`);
  chmodSync(stubPath, 0o755);

  // sudo is mocked in the sandbox already; chmod/chmod are real utilities.
  return runInSandbox(sandbox, command);
}


/**
 * Source a deployment script with OKPROXY_DEPLOY_SOURCE_ONLY=1 and run a body.
 * Extra arguments are passed to the sourced script as its positional params.
 */
function sourceScript(scriptRelPath, args, body, env = {}) {
  const script = join(REPO_ROOT, scriptRelPath);
  return spawnSync(
    'bash',
    ['-c', `source "$1" "\${@:2}"\n${body}`, 'okproxy-test', script, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, OKPROXY_DEPLOY_SOURCE_ONLY: '1', ...env }
    }
  );
}

/** Run openssl, throwing on failure. */
function opensslRun(args) {
  const res = spawnSync('openssl', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout;
}

/** Create a self-signed CA in caDir. */
function generateCa(caDir) {
  mkdirSync(caDir, { recursive: true });
  opensslRun([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(caDir, 'ca-key.pem'),
    '-out', join(caDir, 'ca-cert.pem'),
    '-days', '2', '-subj', '/CN=okproxy test CA'
  ]);
  // Match the production CA layout: initCA() also creates the tracking files
  // that issueServerCertificate() requires.
  writeFileSync(join(caDir, 'crl.txt'), '');
  writeFileSync(join(caDir, 'issued.txt'), '');
  writeFileSync(join(caDir, 'serial-counter.txt'), '1');
  return caDir;
}

/** Issue a server cert/key pair from caDir into certDir. */
function issueServerCert(caDir, certDir, hostname = 'test.example.test') {
  mkdirSync(certDir, { recursive: true });
  const csr = join(certDir, 'server.csr');
  opensslRun([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'server-key.pem'),
    '-out', csr, '-subj', `/CN=${hostname}`
  ]);
  opensslRun([
    'x509', '-req', '-in', csr,
    '-CA', join(caDir, 'ca-cert.pem'),
    '-CAkey', join(caDir, 'ca-key.pem'),
    '-CAcreateserial',
    '-out', join(certDir, 'server-cert.pem'),
    '-days', '2'
  ]);
  rmSync(csr, { force: true });
  rmSync(join(caDir, 'ca-cert.srl'), { force: true });
  return certDir;
}

/**
 * Build a legacy in-checkout trust layout.
 * certDirName/caDirName are relative to baseDir, e.g. 'certs'/'ca' (uploaded
 * layout) or '.certs'/'.ca' (generated layout).
 */
function createTrustLayout(baseDir, {
  certDirName, caDirName, copyCaIntoCertDir = false, hostname = 'legacy.example.test'
} = {}) {
  const caDir = join(baseDir, caDirName);
  const certDir = join(baseDir, certDirName);
  generateCa(caDir);
  issueServerCert(caDir, certDir, hostname);
  if (copyCaIntoCertDir) {
    writeFileSync(join(certDir, 'ca-cert.pem'), readFileSync(join(caDir, 'ca-cert.pem')));
  } else {
    rmSync(join(certDir, 'ca-cert.pem'), { force: true });
  }
  return { caDir, certDir };
}

/** Run git in cwd; throws by default when it fails. */
function gitRun(args, cwd, { allowFailure = false } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'deploy-test',
      GIT_AUTHOR_EMAIL: 'deploy-test@example.test',
      GIT_COMMITTER_NAME: 'deploy-test',
      GIT_COMMITTER_EMAIL: 'deploy-test@example.test'
    }
  });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res;
}

/** Create a fixture git repo (branch main) with a stub client entry point. */
function createFixtureRepo(sandbox, { name = 'repo' } = {}) {
  const repo = join(sandbox.root, name);
  mkdirSync(join(repo, 'apps', 'client'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'client', 'index.js'), '// stub client\n');
  let res = gitRun(['init', '-q', '-b', 'main'], repo, { allowFailure: true });
  if (res.status !== 0) {
    gitRun(['init', '-q'], repo);
    gitRun(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
  }
  gitRun(['add', '-A'], repo);
  gitRun(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

/** Commit a change in a fixture repo and return the new revision. */
function commitFixtureChange(repo, { file = 'apps/client/index.js', content = '// changed\n' } = {}) {
  writeFileSync(join(repo, file), content);
  gitRun(['add', '-A'], repo);
  gitRun(['commit', '-q', '-m', 'change'], repo);
  return gitRun(['rev-parse', 'HEAD'], repo).stdout.trim();
}

module.exports = {
  REPO_ROOT,
  createSandbox,
  cleanupSandbox,
  writeMock,
  writeRemoteMocks,
  writeSudoMock,
  writeSystemctlMock,
  writeLoginctlMock,
  writeJournalctlMock,
  readRemoteLog,
  runInSandbox,
  executeCapturedRemoteCommand,
  sourceScript,
  opensslRun,
  generateCa,
  issueServerCert,
  createTrustLayout,
  gitRun,
  createFixtureRepo,
  commitFixtureChange
};

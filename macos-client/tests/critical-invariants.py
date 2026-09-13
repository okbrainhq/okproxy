#!/usr/bin/env python3
"""Local-only tests: production C helper and extracted installer; no network/GUI.
Swift-only assertions are structural, NOT behavioral Swift tests.
"""
import os, pathlib, re, signal, subprocess, tempfile, time, tarfile, hashlib, json, fcntl
ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'Sources/OkProxyClient/Core'
count = 0

def passed(message):
    global count
    count += 1
    print('PASS', message, flush=True)

def wait_for(predicate):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        if predicate(): return
        time.sleep(.02)
    raise AssertionError('deadline waiting for fixture')

def dead(pid):
    # Linux fixture allows an init-owned zombie, but never a running orphan.
    path = pathlib.Path(f'/proc/{pid}/stat')
    return not path.exists() or path.read_text().split(') ')[1].startswith('Z')

with tempfile.TemporaryDirectory(prefix='okproxy-critical-') as tmp:
    work = pathlib.Path(tmp)
    helper = work / 'helper'
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror',
                    str(ROOT/'Sources/OkProxyProcessHelper/main.c'), '-o', str(helper)], check=True)
    passed('production helper compiles with C warnings as errors on Linux')
    # Exact launch contract: controls blocked by posix_spawn, cancellation sent
    # immediately on return, without a readiness file, sleep, or handshake.
    for control in (signal.SIGTERM, signal.SIGINT, signal.SIGUSR1):
        for _ in range(30):
            pid = os.posix_spawn(str(helper), [str(helper), str(os.getpid()), str(work),
                                '/bin/sleep', '60'], os.environ,
                                setsigmask={signal.SIGTERM, signal.SIGINT, signal.SIGUSR1})
            os.kill(pid, control)
            status = []
            def reaped():
                got, value = os.waitpid(pid, os.WNOHANG)
                if got: status.append(value)
                return bool(got)
            wait_for(reaped)
            assert os.WIFEXITED(status[0]), status
            assert os.WEXITSTATUS(status[0]) in (128 + signal.SIGTERM, 137), status
        passed(f'30 immediate posix_spawn cancellations: {control.name}, normal helper acknowledgement')
    # Workload must not inherit blocked TERM/INT/USR1.
    maskfile = work/'mask'
    pid = os.posix_spawn(str(helper), [str(helper), str(os.getpid()), str(work),
        '/usr/bin/python3', '-c',
        'import signal,sys; assert not signal.pthread_sigmask(signal.SIG_BLOCK, []); open(sys.argv[1], "w").close()',
        str(maskfile)], os.environ, setsigmask={signal.SIGTERM, signal.SIGINT, signal.SIGUSR1})
    assert os.waitpid(pid, 0)[1] == 0 and maskfile.exists()
    passed('workload exec receives empty signal mask')
    def launch(script):
        return subprocess.Popen([str(helper), str(os.getpid()), str(work), '/bin/bash', '-c', script])
    sentinel = subprocess.Popen(['/bin/sleep', '60'])
    try:
        for mode in ('natural', 'term', 'force'):
            pidfile = work / ('pid-' + mode)
            script = f'trap "" TERM; sleep 60 & echo $! > "{pidfile}"; '
            script += 'exit 7' if mode == 'natural' else 'wait'
            proc = launch(script)
            try:
                wait_for(pidfile.exists)
                descendant = int(pidfile.read_text())
                if mode != 'natural': proc.send_signal(signal.SIGTERM if mode == 'term' else signal.SIGUSR1)
                rc = proc.wait(timeout=6)
                assert rc == (7 if mode == 'natural' else 137), rc
                wait_for(lambda: dead(descendant))
                assert sentinel.poll() is None
                passed(f'{mode}: descendant removed, exit preserved, unrelated sentinel untouched')
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGUSR1); proc.wait(timeout=5)
        for _ in range(50):
            proc = launch('exit 0')
            assert proc.wait(timeout=5) == 0
        passed('50 rapid leader-exit/reap cycles')
        # Helper monitors original parent even when the UI process disappears.
        pidfile = work/'orphan-pid'
        owner = subprocess.Popen(['python3', '-c',
            'import subprocess,os,time,sys; p=subprocess.Popen([sys.argv[1],str(os.getpid()),sys.argv[2],"/bin/bash","-c",sys.argv[3]]); '
            'time.sleep(60)', str(helper), str(work), f'trap "" TERM; sleep 60 & echo $! > "{pidfile}"; wait'])
        try:
            wait_for(pidfile.exists)
            descendant = int(pidfile.read_text())
            owner.kill(); owner.wait()
            wait_for(lambda: dead(descendant))
            passed('owner death triggers helper descendant cleanup')
        finally:
            if owner.poll() is None: owner.kill(); owner.wait()
    finally:
        sentinel.terminate(); sentinel.wait()

    # The inherited lease must exclude restart while an old helper cleans up.
    lease = os.open(work/'lease', os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pidfile = work/'lease-ready'
    proc = subprocess.Popen([str(helper), str(os.getpid()), str(work), '/bin/bash', '-c',
                             f'touch "{pidfile}"; sleep 60'], pass_fds=(lease,))
    contender = os.open(work/'lease', os.O_RDWR)
    try:
        wait_for(pidfile.exists)
        os.close(lease)
        try:
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: pass
        else: raise AssertionError('lease released before helper cleanup')
        proc.send_signal(signal.SIGUSR1); proc.wait(timeout=5)
        def released():
            try: fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB); return True
            except BlockingIOError: return False
        wait_for(released)
        passed('inherited state lease blocks relaunch until helper cleanup closes it')
    finally:
        os.close(contender)
        if proc.poll() is None: proc.send_signal(signal.SIGUSR1); proc.wait(timeout=5)

    model = (SRC/'AppModel.swift').read_text()
    body = model.split('private func installLatestNode', 1)[1].split('let script = """', 1)[1].split('"""', 1)[0]
    body = '\n'.join(line[8:] if line.startswith('        ') else line for line in body.splitlines())
    for name, value in [('nodeRoot', '"$TEST_STATE/node"'), ('nodeBin', '"$TEST_STATE/node/bin/node"'), ('statePath', '"$TEST_STATE"')]:
        body = body.replace('\\(' + name + ')', value)
    body = body.replace('\\\\', '\\')
    script = work/'install.sh'; script.write_text(body)
    subprocess.run(['bash', '-n', str(script)], check=True)
    # Execute the ACTUAL recovery prefix, not a Python reimplementation.
    recovery = body.split('        CURL_PROTO=()')[0] if '        CURL_PROTO=()' in body else body.split('CURL_PROTO=()')[0]
    cases = [('', True, False, 'old'), ('', True, True, 'old'),
             ('existing', True, True, 'old'), ('existing', True, False, 'old'),
             ('existing', False, True, 'active'), ('new', False, True, None),
             ('committed', True, True, 'active'), ('committed', False, True, 'active')]
    for index, (phase, previous, active, expected) in enumerate(cases):
        state = work/f'recovery-{index}'; state.mkdir()
        for name, present, marker in [('node.previous',previous,'old'), ('node',active,'active')]:
            if present: (state/name).mkdir(); (state/name/'marker').write_text(marker)
        if phase: (state/'node.transaction').write_text(phase)
        env = dict(os.environ, TEST_STATE=str(state), TMPDIR=str(work))
        for _ in range(2): subprocess.run(['bash', '-c', recovery], env=env, check=True)
        actual = (state/'node/marker').read_text() if (state/'node').exists() else None
        assert actual == expected, (phase, actual, expected)
        assert not (state/'node.previous').exists() and not (state/'node.transaction').exists()
        passed(f'recovery state {index}: {phase or "legacy"}, repeated recovery idempotent')

    # Full install uses file:// fixtures: curl, checksums, extraction, real swap.
    dist = work/'dist'; version = 'v9.9.9'; release = dist/version; release.mkdir(parents=True)
    (dist/'index.json').write_text(json.dumps([{'version':version,'lts':'fixture'}]))
    arch = 'arm64' if os.uname().machine == 'arm64' else 'x64'
    name = f'node-{version}-darwin-{arch}'
    package = work/name; (package/'bin').mkdir(parents=True)
    node = package/'bin/node'
    for mode in ('good', 'wrong-checksum', 'missing-checksum', 'postactivation-failure'):
        node.write_text('#!/bin/sh\n' + ('case "$0" in */node/bin/node) exit 1;; esac\n' if mode == 'postactivation-failure' else '') + 'echo v9.9.9\n')
        node.chmod(0o755)
        archive = release/(name+'.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar: tar.add(package, arcname=name)
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        (release/'SHASUMS256.txt').write_text(('0'*64 if mode == 'wrong-checksum' else checksum) + '  ' + ('other.tar.gz' if mode == 'missing-checksum' else archive.name) + '\n')
        state = work/mode; (state/'node/bin').mkdir(parents=True)
        (state/'node/marker').write_text('old')
        old = state/'node/bin/node'; old.write_text('#!/bin/sh\necho v0.0.1\n'); old.chmod(0o755)
        result = subprocess.run(['bash',str(script)], env=dict(os.environ,TEST_STATE=str(state), TMPDIR=str(work), OKPROXY_NODE_DIST_BASE=dist.as_uri()), capture_output=True, text=True)
        assert (result.returncode == 0) == (mode == 'good'), result.stdout+result.stderr
        assert (state/'node/marker').exists() == (mode != 'good')
        assert not (state/'node.previous').exists() and not (state/'node.transaction').exists()
        passed('offline full installer: '+mode)

    # Kill the real installer DURING activated-binary validation, before commit.
    # The helper kills its owned group; no leftover fixture children/services.
    state = work/'interrupted'; (state/'node/bin').mkdir(parents=True)
    (state/'node/marker').write_text('old')
    node.write_text('#!/bin/sh\ncase "$0" in */node/bin/node) touch "$TEST_STATE/validating"; sleep 60;; esac\necho v9.9.9\n')
    node.chmod(0o755)
    with tarfile.open(archive, 'w:gz') as tar: tar.add(package, arcname=name)
    (release/'SHASUMS256.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
    env = dict(os.environ, TEST_STATE=str(state), TMPDIR=str(work), OKPROXY_NODE_DIST_BASE=dist.as_uri())
    proc = subprocess.Popen([str(helper), str(os.getpid()), str(work), '/bin/bash', str(script)],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: (state/'validating').exists())
        proc.send_signal(signal.SIGUSR1)
        assert proc.wait(timeout=5) == 137
        assert (state/'node').exists() and (state/'node.previous/marker').read_text() == 'old'
        assert (state/'node.transaction').read_text() == 'existing'
        subprocess.run(['bash','-c',recovery], env=env, check=True)
        assert (state/'node/marker').read_text() == 'old'
        passed('real postactivation/prevalidation SIGKILL restores valid backup before use')
    finally:
        if proc.poll() is None: proc.send_signal(signal.SIGUSR1); proc.wait(timeout=5)

    owned = (SRC/'OwnedChildProcess.swift').read_text()
    shell = (SRC/'ShellRunner.swift').read_text()
    supervisor = (SRC/'ProcessSupervisor.swift').read_text()
    assert 'var fileActions: posix_spawn_file_actions_t? = nil' in owned
    assert 'var attributes: posix_spawnattr_t? = nil' in owned
    assert 'killpg(' not in owned
    for name in ('func pollExit()', 'func signalGroup('):
        section = owned.split(name)[1].split('\n    }')[0]
        assert 'stateLock.lock()' in section and 'defer { stateLock.unlock() }' in section
    append = shell.split('func append(_ text: String)')[1].split('func flush()')[0]
    assert 'queue.sync' in append and 'queue.async' not in append
    assert 'completion?(!child.isRunning)' in supervisor
    assert 'role == .client && hasRunningClient' in supervisor
    assert 'guard stopped, client.hasConfirmedExit else' in model and 'recoverNodeTransaction()' in model
    passed('STRUCTURAL ONLY: Swift typed handles, shared lock, bounded append, stop gate/start guard')
print(f'{count} checks passed; Swift/macOS build and execution NOT performed')

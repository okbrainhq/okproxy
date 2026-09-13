#!/usr/bin/env python3
"""Execute extracted production Swift methods, not Python behavior models.
No AppKit or services. Explicitly skip if this host has no Swift compiler.
"""
import pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
core = root/'Sources/OkProxyClient/Core'
shell = (core/'ShellRunner.swift').read_text()
model = (core/'AppModel.swift').read_text()
# Source checks run even on the SDK-less host.
cleanup = model.split('    private func finishClientExit')[1].split('    func stopClient')[0]
assert cleanup.index('gate.release(.clientStop)') < cleanup.index('activeClient = nil')
stop = model.split('    func stopClient()')[1].split('    func showMainWindow')[0]
assert stop.index('client.hasConfirmedExit') < stop.index('gate.active != .clientStop')
assert 'finishClientExit(token: token)' in stop
assert 'bufferedCharacters' not in shell and 'Data(bytes.suffix(maxBytes))' in shell
owned = (core/'OwnedChildProcess.swift').read_text()
for control in ('SIGTERM', 'SIGINT', 'SIGUSR1'):
    assert f'sigaddset(&mask, {control})' in owned
print('PASS reviewer3 source invariants (not Swift runtime verification)', flush=True)
if not shutil.which('swiftc'):
    print('SKIP Swift behavioral regressions: swiftc unavailable')
    raise SystemExit(0)
buffer = shell[shell.index('private final class ShellOutputBuffer'):]
# Expose internals only in the extracted test copy, to inspect stalled delivery.
buffer = buffer.replace('private ', '')
methods = model[model.index('    private func finishClientExit'):model.index('    func showMainWindow')].replace('private ', '')
stubs = '''
final class Child {
    var hasConfirmedExit = false
}
final class Supervisor {
    var callbacks: [(Bool) -> Void] = []
    func stop(_ child: Child, gracePeriod: Double, completion: @escaping (Bool) -> Void) {
        callbacks.append(completion)
    }
}
final class Logs { func append(_ text: String) {} }
final class Fixture {
    let gate = OperationGate()
    let supervisor = Supervisor()
    let logs = Logs()
    var activeClient: Child?
    var activeClientToken: UUID?
    var isRunningClient = true
'''
tests = r'''
let f = Fixture()
let old = Child()
f.activeClient = old
f.activeClientToken = UUID()
let oldToken = f.activeClientToken!
f.stopClient()
f.stopClient()
precondition(f.supervisor.callbacks.count == 1)
precondition(f.gate.active == .clientStop)
old.hasConfirmedExit = true // reap off-main, onExit still queued
f.stopClient()             // second Stop in reviewer's race window
precondition(f.gate.active == nil && f.activeClientToken == nil)
precondition(f.gate.acquire(.clientStart))
f.gate.release(.clientStart)
f.activeClient = Child()
f.activeClientToken = UUID()
f.stopClient()
f.supervisor.callbacks[0](true) // delayed OLD completion
f.finishClientExit(token: oldToken) // delayed OLD onExit
precondition(f.gate.active == .clientStop && f.activeClient != nil)
f.supervisor.callbacks[1](false)
precondition(f.gate.active == .clientStop) // timeout retains ownership
f.activeClient!.hasConfirmedExit = true
f.supervisor.callbacks[1](true)
precondition(f.gate.active == nil && f.activeClient == nil)
print("PASS extracted production stop: reap-before-callback, duplicate Stop, stale callbacks, timeout")

let b = ShellOutputBuffer(maxCharacters: 4097, log: { _ in })
b.queue.sync { b.deliveryInFlight = true } // deliberately stalled consumer
b.append("a")
for _ in 0..<20000 { b.append("\u{301}") }
b.append(String(repeating: "\u{301}", count: 100000))
b.append(String(repeating: "😀", count: 2000))
b.queue.sync {
    precondition(b.buffer.count <= 4097)
    precondition(String(data: b.buffer, encoding: .utf8) != nil)
    precondition(b.droppedBytes > 0 && !b.flushScheduled)
}
b.flush()
b.queue.sync { precondition(b.buffer.count <= 4097) }
print("PASS extracted production buffer: combining flood, huge chunk, UTF-8 cuts, stalled consumer")
'''
with tempfile.TemporaryDirectory(prefix='okproxy-reviewer3-') as tmp:
    source = pathlib.Path(tmp)/'main.swift'
    source.write_text('import Foundation\n' + (core/'OperationGate.swift').read_text() + buffer + stubs + methods + '\n}\n' + tests)
    binary = pathlib.Path(tmp)/'checks'
    subprocess.run(['swiftc', '-swift-version', '5', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=30)

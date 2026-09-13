#!/usr/bin/env python3
"""Execute extracted production Swift methods, not Python behavior models.
No AppKit or services. Explicitly skip if this host has no Swift compiler.
"""
import pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
core = root/'Sources/OkProxyClient/Core'
shell = (core/'ShellRunner.swift').read_text()
model = (core/'AppModel.swift').read_text()
supervisor_source = (core/'ProcessSupervisor.swift').read_text()
# Source checks run even on the SDK-less host.
cleanup = model.split('    private func finishClientExit')[1].split('    func stopClient')[0]
assert cleanup.index('gate.release(.clientStop)') < cleanup.index('activeClient = nil')
stop = model.split('    func stopClient()')[1].split('    func showMainWindow')[0]
assert stop.index('client.hasConfirmedExit') < stop.index('gate.active != .clientStop')
assert 'finishClientExit(token: token)' in stop
# The retention bug: a stop that could not be confirmed used to keep the client
# and the stop gate forever. Every stop now completes through one terminal path.
assert 'guard stopped, client.hasConfirmedExit else' not in stop
assert 'completeStop(outcome, token: token)' in stop
assert 'func forceStopClient()' in stop and 'supervisor.forceStop(client)' in stop
complete = stop.split('private func completeStop')[1]
assert 'finishClientExit(token: token)' in complete
assert complete.index('case .cleanupIncomplete') < complete.index('finishClientExit(token: token)')
for outcome in ('.confirmedClean', '.cleanupIncomplete', '.forcedUnconfirmed'):
    assert outcome in supervisor_source
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
enum StopOutcome {
    case confirmedClean
    case cleanupIncomplete(String)
    case forcedUnconfirmed(String)
    var needsAttention: Bool { if case .confirmedClean = self { return false }; return true }
}
struct SweepReport {
    var inspectedRecords = 0
    var needsAttention = false
    var summary = "sweep"
    var unverified: [String] = []
}
final class Child {
    var hasConfirmedExit = false
}
final class Supervisor {
    var callbacks: [(StopOutcome) -> Void] = []
    func stop(_ child: Child, gracePeriod: Double, completion: (@MainActor (StopOutcome) -> Void)? = nil) {
        if let completion { callbacks.append(completion) }
    }
    func forceStop(_ child: Child, completion: (@MainActor (StopOutcome) -> Void)? = nil) {
        if let completion { callbacks.append(completion) }
    }
    func reclaimRecordedRuns(reason: String) -> SweepReport { SweepReport() }
    func reclaimOrphanedRuns(reason: String) -> SweepReport { SweepReport() }
    func sweepStaleRunRecords() -> SweepReport { SweepReport() }
}
final class Logs { func append(_ text: String) {} }
final class Fixture {
    let gate = OperationGate()
    let supervisor = Supervisor()
    let logs = Logs()
    var activeClient: Child?
    var activeClientToken: UUID?
    var isRunningClient = true
    var lastStopNotice: String?
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

// A stale completion/exit from a replaced client must not touch the new one.
f.activeClient = Child()
f.activeClientToken = UUID()
f.stopClient()
f.supervisor.callbacks[0](.forcedUnconfirmed("stale stop"))
f.finishClientExit(token: oldToken)
precondition(f.gate.active == .clientStop && f.activeClient != nil)

// THE FIX: a stop that had to be forced still completes the transaction, so the
// app can never end up unable to stop, start, update or quit again.
f.supervisor.callbacks[1](.forcedUnconfirmed("supervisor had to be reclaimed by force"))
precondition(f.gate.active == nil && f.activeClient == nil && f.activeClientToken == nil)
precondition(f.lastStopNotice != nil)
precondition(f.gate.acquire(.clientStart))
f.gate.release(.clientStart)

// A clean stop clears the notice and stays idempotent.
f.activeClient = Child()
f.activeClientToken = UUID()
f.stopClient()
f.stopClient()
f.supervisor.callbacks[2](.confirmedClean)
precondition(f.gate.active == nil && f.activeClient == nil && f.lastStopNotice == nil)

// An incomplete-cleanup stop is reported AND still releases the gate.
f.activeClient = Child()
f.activeClientToken = UUID()
f.stopClient()
f.supervisor.callbacks[3](.cleanupIncomplete("descendant cleanup unverified"))
precondition(f.gate.active == nil && f.lastStopNotice != nil)

// Force Stop is always available, even mid-transaction, and always completes.
f.activeClient = Child()
f.activeClientToken = UUID()
f.stopClient()
f.forceStopClient()
precondition(f.supervisor.callbacks.count == 6)
f.supervisor.callbacks[5](.forcedUnconfirmed("reclaimed by force"))
precondition(f.gate.active == nil && f.activeClient == nil && f.activeClientToken == nil)
precondition(f.lastStopNotice != nil)
precondition(f.gate.acquire(.clientStart))
f.gate.release(.clientStart)

// The graceful stop's completion arriving after the forced one is stale and must
// not disturb a newer client.
f.activeClient = Child()
f.activeClientToken = UUID()
f.supervisor.callbacks[4](.confirmedClean)
precondition(f.gate.active == nil && f.activeClient != nil && f.lastStopNotice != nil)
f.activeClient = nil
f.activeClientToken = nil

// Force Stop with nothing owned still clears a wedged stop transaction.
f.activeClient = nil
f.activeClientToken = nil
_ = f.gate.acquire(.clientStop)
f.forceStopClient()
precondition(f.gate.active == nil && f.isRunningClient == false)
print("PASS extracted production stop: reap-before-callback, duplicate Stop, stale callbacks, forced completion, force stop")

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
    source.write_text(
        'import Foundation\n'
        + (core/'OperationGate.swift').read_text()
        + buffer + stubs + methods + '\n}\n' + tests
    )
    binary = pathlib.Path(tmp)/'checks'
    subprocess.run(['swiftc', '-swift-version', '5', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=30)

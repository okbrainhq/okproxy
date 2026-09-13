import Darwin
import Foundation

/// How one supervised child's stop ended.
///
/// Every case means the app no longer owns the child, so no caller can be left
/// holding an operation gate forever. The distinction is only about honesty:
/// whether cleanup was confirmed, or had to be reclaimed and reported.
enum StopOutcome {
    /// The helper reaped its workload, verified descendant cleanup and exited.
    case confirmedClean
    /// The helper reaped its workload but could not verify descendant cleanup
    /// (it exited 126 and retained its run record).
    case cleanupIncomplete(String)
    /// The helper itself had to be reclaimed (killed, or seal-released): the app
    /// swept the recorded leftovers and reports what actually happened.
    case forcedUnconfirmed(String)

    var needsAttention: Bool {
        if case .confirmedClean = self { return false }
        return true
    }

    var summary: String {
        switch self {
        case .confirmedClean: return "clean"
        case .cleanupIncomplete(let reason): return reason
        case .forcedUnconfirmed(let reason): return reason
        }
    }
}

struct StopReport {
    var outcomes: [StopOutcome] = []

    var needsAttention: Bool { outcomes.contains { $0.needsAttention } }

    var summary: String {
        guard !outcomes.isEmpty else { return "no supervised processes were running" }
        let attention = outcomes.filter { $0.needsAttention }
        if attention.isEmpty { return "all supervised processes stopped cleanly" }
        return "stopped with attention: " + attention.map { $0.summary }.joined(separator: "; ")
    }
}

/// Registry for owned direct-child helpers. A helper holds its workload leader
/// unreaped until the final descendant group signal.
///
/// Stop is bounded at every rung: graceful signal, forced signal, then a reclaim
/// that SIGKILLs the helper itself. A child that cannot be confirmed dead is
/// sealed with an explicit reason, so "stop" always completes and the operation
/// gate is never retained indefinitely.
@MainActor
final class ProcessSupervisor {
    static let shared = ProcessSupervisor()

    private var shuttingDown = false
    private var processes: [OwnedChildProcess] = []
    private let cleanupQueue = DispatchQueue(label: "OkProxyClient.child-cleanup", qos: .userInitiated)

    private init() {}

    var hasRunningSetup: Bool {
        processes.contains { $0.role == .setup && $0.isRunning }
    }

    var runningProcessCount: Int {
        processes.filter(\.isRunning).count
    }

    var hasRunningClient: Bool {
        processes.contains { $0.role == .client && $0.isRunning }
    }

    /// Spawn and take ownership. Returns `nil` when a conflicting `.setup` child
    /// is already running (or when the process could not be spawned at all).
    @discardableResult
    func spawn(
        executable: String,
        arguments: [String],
        cwd: String? = nil,
        role: ProcessRole,
        environment: [String: String] = [:],
        output: OutputMode,
        log: @escaping @MainActor (String) -> Void = { _ in },
        onExit: @escaping @MainActor (ChildExit) -> Void
    ) -> OwnedChildProcess? {
        reapConfirmedExits()
        if shuttingDown || (role == .setup && hasRunningSetup) || (role == .client && hasRunningClient) {
            return nil
        }

        // The helper records the workload's process group so the app can still
        // find and reclaim it if the helper crashes or has to be killed.
        var merged = environment
        for (key, value) in RunRecordStore.environment(role: role, workloadExecutable: executable) {
            merged[key] = value
        }

        var handleID: UUID?
        let handle = ShellRunner.spawn(
            executable: executable,
            arguments: arguments,
            cwd: cwd,
            role: role,
            environment: merged,
            output: output,
            log: log,
            onExit: { [weak self] result in
                guard let self else {
                    onExit(result)
                    return
                }
                let helperPid = handleID.flatMap { identifier in
                    self.processes.first { $0.id == identifier }?.pid
                }
                if let handleID {
                    self.processes.removeAll { $0.id == handleID }
                }
                self.settleRecord(helperPid: helperPid, result: result, deliver: onExit)
            }
        )

        if let handle {
            handleID = handle.id
            processes.append(handle)
        }
        return handle
    }

    /// SIGTERM → grace → helper force signal → bounded reclaim. Always completes.
    func stop(_ child: OwnedChildProcess, gracePeriod: TimeInterval = 2.0, completion: (@MainActor (StopOutcome) -> Void)? = nil) {
        guard child.isRunning else {
            completion?(ProcessSupervisor.outcome(for: child))
            return
        }

        child.requestTermination()
        child.signalGroup(SIGTERM) // helper: SIGTERM to the workload group

        cleanupQueue.async {
            // Rung 1: graceful group shutdown.
            if ProcessSupervisor.waitForExit(child, seconds: gracePeriod) {
                let settled = ProcessSupervisor.outcome(for: child)
                Task { @MainActor in completion?(settled) }
                return
            }
            // Rung 2: helper force control - it SIGKILLs the group and reaps.
            child.signalGroup(SIGKILL)
            if ProcessSupervisor.waitForExit(child, seconds: 2.0) {
                let settled = ProcessSupervisor.outcome(for: child)
                Task { @MainActor in completion?(settled) }
                return
            }
            // Rung 3: the helper itself is wedged. Sweep the recorded group first
            // (only the record knows its id), then reclaim the helper.
            let reclaimed = ProcessSupervisor.forceReclaim(child)
            Task { @MainActor in completion?(reclaimed) }
        }
    }

    /// Explicit, always-available escape hatch: skip the graceful window and
    /// reclaim the child immediately.
    func forceStop(_ child: OwnedChildProcess, completion: (@MainActor (StopOutcome) -> Void)? = nil) {
        guard child.isRunning else {
            completion?(ProcessSupervisor.outcome(for: child))
            return
        }
        child.requestTermination()
        cleanupQueue.async {
            let reclaimed = ProcessSupervisor.forceReclaim(child)
            Task { @MainActor in completion?(reclaimed) }
        }
    }

    /// Stop every owned child, then run `completion` on the main actor. The
    /// completion always fires: a wedged helper is reclaimed, never waited for.
    func stopAll(gracePeriod: TimeInterval = 2.0, completion: (@MainActor (StopReport) -> Void)? = nil) {
        shuttingDown = true
        let active = processes.filter(\.isRunning)
        guard !active.isEmpty else {
            completion?(StopReport())
            return
        }

        let group = DispatchGroup()
        let collector = StopCollector()
        for child in active {
            group.enter()
            stop(child, gracePeriod: gracePeriod) { outcome in
                collector.append(outcome)
                group.leave()
            }
        }
        group.notify(queue: .main) {
            Task { @MainActor in completion?(StopReport(outcomes: collector.outcomes)) }
        }
    }

    /// Final synchronous sweep used from `applicationWillTerminate`. Bounded: at
    /// most `gracePeriod + 2.5s`, and nothing is left owned at the end.
    @discardableResult
    func terminateAllNow(gracePeriod: TimeInterval = 1.0) -> StopReport {
        shuttingDown = true
        var report = StopReport()
        let active = processes.filter(\.isRunning)
        guard !active.isEmpty else { return report }

        for child in active {
            child.requestTermination()
            child.signalGroup(SIGTERM)
        }
        ProcessSupervisor.waitForAnyExit(active, seconds: gracePeriod)

        for child in active where child.isRunning {
            child.signalGroup(SIGKILL)
        }
        ProcessSupervisor.waitForAnyExit(active, seconds: 1.0)

        for child in active {
            report.outcomes.append(child.isRunning ? ProcessSupervisor.forceReclaim(child) : ProcessSupervisor.outcome(for: child))
        }
        reapConfirmedExits()
        return report
    }

    /// Reclaims run records left behind by earlier launches. Called at startup so
    /// a helper that was stranded by a crash, a force quit or a kill can never
    /// keep the app from starting or stopping its client.
    @discardableResult
    func sweepStaleRunRecords() -> SweepReport {
        let report = RunRecordStore.sweepStaleRecords()
        reapConfirmedExits()
        return report
    }

    /// Reclaims every recorded run, except the ones owned by a child this app
    /// still supervises. Used before starting a client so a leftover can never
    /// run alongside a new one.
    @discardableResult
    func reclaimOrphanedRuns(reason: String) -> SweepReport {
        let owned = Set(processes.filter { $0.isRunning }.map { $0.pid })
        let report = RunRecordStore.reclaimAll(reason: reason, excluding: owned)
        reapConfirmedExits()
        return report
    }

    /// Reclaims every recorded run, including ones still recorded by this app.
    @discardableResult
    func reclaimRecordedRuns(reason: String) -> SweepReport {
        let report = RunRecordStore.reclaimAll(reason: reason)
        reapConfirmedExits()
        return report
    }

    // MARK: - Internals

    /// Terminal classification for one child. Never blocks on the helper.
    nonisolated static func outcome(for child: OwnedChildProcess) -> StopOutcome {
        guard let exit = child.terminalOutcome() else {
            return .forcedUnconfirmed("supervision ended without a terminal state")
        }
        if exit.cleanupAttention {
            let report = RunRecordStore.reclaim(helperPid: child.pid)
            return .cleanupIncomplete(
                report.isVerifiedClean
                    ? "supervisor reported incomplete descendant cleanup; recorded leftovers were swept"
                    : report.summary
            )
        }
        if let reason = exit.failureReason {
            return .forcedUnconfirmed(reason)
        }
        return .confirmedClean
    }

    /// Rung 3. The record is the only handle on the workload group after the
    /// helper is gone, so sweep it first, then reclaim the helper itself.
    nonisolated static func forceReclaim(_ child: OwnedChildProcess) -> StopOutcome {
        let report = RunRecordStore.reclaim(helperPid: child.pid)
        child.terminateSupervisorNow()
        let reaped = waitForExit(child, seconds: 1.5)
        if !reaped {
            child.seal(reason: "supervisor did not exit after SIGKILL; supervision released with an unconfirmed exit")
        }
        if !report.isVerifiedClean {
            return .forcedUnconfirmed("forced reclaim incomplete: \(report.summary)")
        }
        return .forcedUnconfirmed("supervisor had to be reclaimed by force; recorded leftovers were swept")
    }

    /// Post-exit bookkeeping for children that were not stopped by the user
    /// (setup scripts, version probes, or a client that exited on its own).
    /// Runs off the main actor; the record sweep can block briefly.
    private func settleRecord(helperPid: pid_t?, result: ChildExit, deliver: @escaping @MainActor (ChildExit) -> Void) {
        guard let helperPid else {
            deliver(result)
            return
        }
        cleanupQueue.async {
            var delivered = result
            if result.cleanupAttention {
                let report = RunRecordStore.reclaim(helperPid: helperPid)
                if !report.isVerifiedClean {
                    delivered = ChildExit(
                        exitCode: result.exitCode,
                        signal: result.signal,
                        capturedOutput: result.capturedOutput,
                        failureReason: "recorded leftovers could not be fully reclaimed: \(report.summary)",
                        cleanupAttention: true
                    )
                }
            } else if result.failureReason != nil {
                // The helper died without confirming cleanup: sweep whatever its
                // record still knows about before reporting an unconfirmed exit.
                _ = RunRecordStore.reclaim(helperPid: helperPid)
            } else {
                // Clean exit: the helper already removed its record. This is a
                // guard for a helper killed between reaping and unlinking.
                RunRecordStore.remove(helperPid: helperPid)
            }
            Task { @MainActor in deliver(delivered) }
        }
    }

    nonisolated static func waitForExit(_ child: OwnedChildProcess, seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !child.isRunning { return true }
            usleep(20_000)
        }
        return !child.isRunning
    }

    nonisolated static func waitForAnyExit(_ children: [OwnedChildProcess], seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !children.contains(where: { $0.isRunning }) { return }
            usleep(20_000)
        }
    }

    /// Drop children whose exit `waitpid` has confirmed.
    private func reapConfirmedExits() {
        processes.removeAll { $0.hasConfirmedExit }
    }
}

/// Small lock-protected collector so parallel stop completions cannot race on a
/// shared array while the group notification is pending.
final class StopCollector {
    private let lock = NSLock()
    private var stored: [StopOutcome] = []

    func append(_ outcome: StopOutcome) {
        lock.lock()
        stored.append(outcome)
        lock.unlock()
    }

    var outcomes: [StopOutcome] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

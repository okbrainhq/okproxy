import Darwin
import Foundation

/// Registry for owned direct-child helpers. A helper holds its workload leader
/// unreaped until the final descendant group signal. Stop deadlines return false,
/// retaining ownership; main-actor callbacks are not part of the reaping lock.
@MainActor
final class ProcessSupervisor {
    static let shared = ProcessSupervisor()

    private var shuttingDown = false
    private var processes: [OwnedChildProcess] = []

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

        var handleID: UUID?
        let handle = ShellRunner.spawn(
            executable: executable,
            arguments: arguments,
            cwd: cwd,
            role: role,
            environment: environment,
            output: output,
            log: log,
            onExit: { [weak self] result in
                if let handleID {
                    self?.processes.removeAll { $0.id == handleID }
                }
                onExit(result)
            }
        )

        if let handle {
            handleID = handle.id
            processes.append(handle)
        }
        return handle
    }

    /// SIGTERM → grace → SIGKILL for one owned child, completing only after the
    /// confirmed exit (or after the post-SIGKILL confirmation window).
    func stop(_ child: OwnedChildProcess, gracePeriod: TimeInterval = 2.0, completion: ((Bool) -> Void)? = nil) {
        guard child.isRunning else {
            completion?(true)
            return
        }

        child.requestTermination()
        child.signalGroup(SIGTERM)

        let hardDeadline = Date().addingTimeInterval(gracePeriod)
        DispatchQueue.global(qos: .utility).async {
            while child.isRunning, Date() < hardDeadline {
                usleep(50_000)
            }
            if child.isRunning {
                child.signalGroup(SIGKILL)
            }
            let confirmationDeadline = Date().addingTimeInterval(2.0)
            while child.isRunning, Date() < confirmationDeadline {
                usleep(50_000)
            }
            Task { @MainActor in completion?(!child.isRunning) }
        }
    }

    /// Stop every owned child, then run `completion` on the main actor.
    func stopAll(gracePeriod: TimeInterval = 2.0, completion: ((Bool) -> Void)? = nil) {
        shuttingDown = true
        let active = processes.filter(\.isRunning)
        guard !active.isEmpty else {
            completion?(true)
            return
        }

        let group = DispatchGroup()
        for child in active {
            group.enter()
            stop(child, gracePeriod: gracePeriod) { _ in
                group.leave()
            }
        }
        group.notify(queue: .main) {
            completion?(!active.contains(where: { $0.isRunning }))
        }
    }

    /// Final synchronous sweep used from `applicationWillTerminate`.
    func terminateAllNow(gracePeriod: TimeInterval = 1.5) {
        let active = processes.filter(\.isRunning)
        guard !active.isEmpty else { return }

        for child in active {
            child.requestTermination()
            child.signalGroup(SIGTERM)
        }

        let deadline = Date().addingTimeInterval(gracePeriod)
        while Date() < deadline, active.contains(where: { $0.isRunning }) {
            usleep(50_000)
        }

        for child in active where child.isRunning {
            child.signalGroup(SIGKILL)
        }

        let confirmationDeadline = Date().addingTimeInterval(2.0)
        while Date() < confirmationDeadline, active.contains(where: { $0.isRunning }) {
            usleep(50_000)
        }
        reapConfirmedExits()
    }

    /// Drop children whose exit `waitpid` has confirmed.
    private func reapConfirmedExits() {
        processes.removeAll { $0.hasConfirmedExit }
    }
}

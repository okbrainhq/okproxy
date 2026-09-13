import Darwin
import Foundation

/// Result of a supervised child, delivered only after the helper's exit was
/// confirmed or the child was explicitly reclaimed.
struct ChildExit {
    let exitCode: Int32
    let signal: Int32?
    let capturedOutput: String?
    let failureReason: String?
    /// The helper reaped its workload but could not verify descendant cleanup
    /// (helper exit code 126). The app sweeps and reports instead of pretending
    /// the stop was clean.
    var cleanupAttention: Bool = false

    var didFailToSpawn: Bool { failureReason != nil }

    static func spawnFailure(_ reason: String) -> ChildExit {
        ChildExit(exitCode: -1, signal: nil, capturedOutput: nil, failureReason: reason)
    }
}

enum ChildSpawnError: Error {
    case pipeUnavailable(Int32)
    case outputFileUnavailable(Int32)
    case spawnFailed(Int32)

    var message: String {
        switch self {
        case .pipeUnavailable(let code): return "pipe(2) failed (errno \(code))"
        case .outputFileUnavailable(let code): return "could not create capture file (errno \(code))"
        case .spawnFailed(let code): return "posix_spawn failed (errno \(code))"
        }
    }
}

/// Owns only the persistent helper PID. Signaling and nonblocking reaping share
/// one synchronous lock; no main-actor callback is needed to invalidate identity.
///
/// Every child reaches exactly one terminal state. A failed `waitpid`, a helper
/// that exited on a signal, and a reclaim that had to SIGKILL the helper all
/// produce a terminal `ChildExit`; none of them may leave the caller waiting for
/// a completion that can never arrive, because that is what turns one stuck
/// supervisor into an app that can no longer stop, start, or update anything.
final class OwnedChildProcess {
    let id = UUID()
    let role: ProcessRole
    let executablePath: String
    let pid: pid_t
    let processGroupID: pid_t
    let captureURL: URL?

    private let stateLock = NSLock()
    private var confirmedExit: ChildExit?
    private var terminalFailureCode: Int32?
    private var terminationRequested = false
    private var identityOwned = true

    /// Kernel errno behind an unconfirmable exit (ECHILD/EPERM), when there was one.
    var failureCode: Int32? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return terminalFailureCode
    }

    init(role: ProcessRole, executablePath: String, pid: pid_t, captureURL: URL?) {
        self.role = role
        self.executablePath = executablePath
        self.pid = pid
        self.processGroupID = pid
        self.captureURL = captureURL
    }

    var hasConfirmedExit: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return confirmedExit != nil
    }

    var isRunning: Bool { !hasConfirmedExit }

    var requestedTermination: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return terminationRequested
    }

    func requestTermination() {
        stateLock.lock()
        terminationRequested = true
        stateLock.unlock()
    }

    /// The terminal outcome, whichever way the child ended.
    func terminalOutcome() -> ChildExit? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return confirmedExit
    }

    /// Terminates supervision of a child that had to be reclaimed by force.
    /// Records an honest failure reason instead of fabricating a clean exit.
    func seal(reason: String) {
        stateLock.lock()
        defer { stateLock.unlock() }
        identityOwned = false
        if confirmedExit == nil {
            confirmedExit = ChildExit(exitCode: 137, signal: SIGKILL, capturedOutput: nil, failureReason: reason)
        }
    }

    /// Called off-main. WNOHANG keeps lock hold time bounded. Always leaves a
    /// terminal state behind when it returns without a status.
    func pollExit() -> Int32? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard identityOwned else { return nil }
        var status: Int32 = 0
        let waited = waitpid(pid, &status, WNOHANG)
        if waited == 0 || (waited == -1 && errno == EINTR) { return nil }
        identityOwned = false // invalidate under the SAME lock as signaling
        if waited == -1 {
            terminalFailureCode = errno
            confirmedExit = ChildExit(
                exitCode: -1,
                signal: nil,
                capturedOutput: nil,
                failureReason: "supervisor exit could not be confirmed (errno \(errno))"
            )
            return nil
        }
        let exit = PosixChildProcess.decode(status: status)
        if let signal = exit.signal {
            // The helper was killed rather than finishing its own cleanup: the
            // workload group may still be alive, so this is reported, never
            // decoded as a clean stop.
            terminalFailureCode = ECHILD
            confirmedExit = ChildExit(
                exitCode: exit.code,
                signal: signal,
                capturedOutput: nil,
                failureReason: "supervisor exited on signal \(signal) without confirming cleanup"
            )
            return nil
        }
        confirmedExit = ChildExit(exitCode: exit.code, signal: nil, capturedOutput: nil, failureReason: nil)
        return status
    }

    /// Compatibility name; only the unreaped direct helper is signaled.
    @discardableResult
    func signalGroup(_ signal: Int32) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard identityOwned, pid > 1 else { return false }
        // Never SIGKILL the supervisor: it must finish descendant cleanup first.
        return kill(pid, signal == SIGKILL ? SIGUSR1 : signal) == 0
    }

    /// Last-resort reclaim of the helper itself, used only after the recorded
    /// workload group has been signalled by the app. Returns `true` when the
    /// SIGKILL was delivered.
    @discardableResult
    func terminateSupervisorNow() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard identityOwned, pid > 1 else { return false }
        return kill(pid, SIGKILL) == 0
    }
}

enum PosixChildProcess {
    struct Spawned {
        let pid: pid_t
        let captureURL: URL?
        let readFileDescriptor: Int32
    }

    /// The helper is shipped alongside the app executable.
    static var helperExecutablePath: String {
        URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent().appendingPathComponent("OkProxyProcessHelper").path
    }

    /// Spawn a child in its own process group with stdin from /dev/null.
    /// - Parameter captureOutput: when true, stdout+stderr go to a private temp
    ///   file (no pipe deadlock risk) and `Spawned.readFileDescriptor` is -1.
    static func spawn(
        executable: String,
        arguments: [String],
        cwd: String?,
        environment: [String: String],
        captureOutput: Bool
    ) throws -> Spawned {
        var outputFileDescriptor: Int32 = -1
        var readFileDescriptor: Int32 = -1
        var captureURL: URL?

        if captureOutput {
            let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            let fileURL = directory.appendingPathComponent("okproxy-child-\(UUID().uuidString).log")
            let descriptor = open(fileURL.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
            guard descriptor >= 0 else { throw ChildSpawnError.outputFileUnavailable(errno) }
            outputFileDescriptor = descriptor
            captureURL = fileURL
        } else {
            var descriptors: [Int32] = [-1, -1]
            guard pipe(&descriptors) == 0 else { throw ChildSpawnError.pipeUnavailable(errno) }
            readFileDescriptor = descriptors[0]
            outputFileDescriptor = descriptors[1]
        }

        var didSpawn = false
        defer {
            if outputFileDescriptor >= 0 { close(outputFileDescriptor) }
            if !didSpawn {
                if readFileDescriptor >= 0 { close(readFileDescriptor) }
                if let captureURL { try? FileManager.default.removeItem(at: captureURL) }
            }
        }
        func check(_ code: Int32) throws {
            guard code == 0 else { throw ChildSpawnError.spawnFailed(code) }
        }
        let nullDescriptor = open("/dev/null", O_RDONLY)
        guard nullDescriptor >= 0 else { throw ChildSpawnError.spawnFailed(errno) }
        defer { close(nullDescriptor) }

        var fileActions: posix_spawn_file_actions_t? = nil
        try check(posix_spawn_file_actions_init(&fileActions))
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        if nullDescriptor >= 0 {
            try check(posix_spawn_file_actions_adddup2(&fileActions, nullDescriptor, STDIN_FILENO))
            if nullDescriptor > STDERR_FILENO {
                try check(posix_spawn_file_actions_addclose(&fileActions, nullDescriptor))
            }
        }
        try check(posix_spawn_file_actions_adddup2(&fileActions, outputFileDescriptor, STDOUT_FILENO))
        try check(posix_spawn_file_actions_adddup2(&fileActions, outputFileDescriptor, STDERR_FILENO))
        if outputFileDescriptor > STDERR_FILENO {
            try check(posix_spawn_file_actions_addclose(&fileActions, outputFileDescriptor))
        }
        if readFileDescriptor >= 0 {
            try check(posix_spawn_file_actions_addclose(&fileActions, readFileDescriptor))
        }

        var attributes: posix_spawnattr_t? = nil
        try check(posix_spawnattr_init(&attributes))
        defer { posix_spawnattr_destroy(&attributes) }
        try check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)))
        try check(posix_spawnattr_setpgroup(&attributes, 0))
        var mask = sigset_t()
        sigemptyset(&mask)
        // Pending control signals survive exec until the helper is ready.
        sigaddset(&mask, SIGTERM)
        sigaddset(&mask, SIGINT)
        sigaddset(&mask, SIGUSR1)
        try check(posix_spawnattr_setsigmask(&attributes, &mask))
        // A launcher that ignores a control signal (a non-interactive shell
        // ignores SIGINT, for example) would otherwise make an immediate cancel
        // be discarded by the kernel before the helper can install its handler.
        // The helper must always be able to observe a cancellation request.
        var defaultSignals = sigset_t()
        sigemptyset(&defaultSignals)
        sigaddset(&defaultSignals, SIGTERM)
        sigaddset(&defaultSignals, SIGINT)
        sigaddset(&defaultSignals, SIGUSR1)
        try check(posix_spawnattr_setsigdefault(&attributes, &defaultSignals))

        // Helper is shipped alongside the app executable; no shell interpolation.
        let program = helperExecutablePath
        let argumentStrings = [program, String(getpid()), cwd ?? FileManager.default.currentDirectoryPath,
                               executable] + arguments

        var mergedEnvironment = ProcessInfo.processInfo.environment
        for (key, value) in environment { mergedEnvironment[key] = value }

        var argumentPointers: [UnsafeMutablePointer<CChar>?] = argumentStrings.map { strdup($0) }
        argumentPointers.append(nil)
        var environmentPointers: [UnsafeMutablePointer<CChar>?] = mergedEnvironment.map { strdup("\($0.key)=\($0.value)") }
        environmentPointers.append(nil)
        defer {
            for case let pointer? in argumentPointers { free(UnsafeMutableRawPointer(pointer)) }
            for case let pointer? in environmentPointers { free(UnsafeMutableRawPointer(pointer)) }
        }

        var pid: pid_t = -1
        let spawnResult = argumentPointers.withUnsafeBufferPointer { argumentBuffer in
            environmentPointers.withUnsafeBufferPointer { environmentBuffer in
                posix_spawn(
                    &pid,
                    program,
                    &fileActions,
                    &attributes,
                    argumentBuffer.baseAddress,
                    environmentBuffer.baseAddress
                )
            }
        }

        guard spawnResult == 0, pid > 0 else {
            throw ChildSpawnError.spawnFailed(spawnResult == 0 ? EINVAL : spawnResult)
        }
        didSpawn = true

        return Spawned(pid: pid, captureURL: captureURL, readFileDescriptor: readFileDescriptor)
    }

    /// Reap `pid` with `waitpid`, then read bounded captured output.
    /// `onExit` runs on a utility queue; callers hop to the main actor. The
    /// callback fires exactly once for every spawn: a lost `waitpid`, an
    /// externally killed helper and a forced reclaim all deliver a terminal
    /// `ChildExit` rather than returning silently.
    static func monitor(
        child: OwnedChildProcess,
        captureURL: URL?,
        maxCapturedBytes: Int,
        onOwnershipFailure: @escaping (Int32) -> Void,
        onExit: @escaping (ChildExit) -> Void
    ) {
        DispatchQueue.global(qos: .utility).async {
            func finish(_ exit: ChildExit) {
                var captured: String?
                if let captureURL {
                    captured = readCapturedOutput(at: captureURL, maxBytes: maxCapturedBytes)
                    try? FileManager.default.removeItem(at: captureURL)
                }
                onExit(ChildExit(
                    exitCode: exit.exitCode,
                    signal: exit.signal,
                    capturedOutput: exit.capturedOutput ?? captured,
                    failureReason: exit.failureReason,
                    cleanupAttention: exit.cleanupAttention
                ))
            }

            while true {
                if let status = child.pollExit() {
                    let exit = decode(status: status)
                    finish(ChildExit(exitCode: exit.code, signal: exit.signal,
                                     capturedOutput: nil, failureReason: nil))
                    return
                }
                if let terminal = child.terminalOutcome() {
                    if let code = child.failureCode { onOwnershipFailure(code) }
                    finish(terminal)
                    return
                }
                usleep(20_000)
            }
        }
    }

    /// Exit code / terminating signal from a raw waitpid status word.
    static func decode(status: Int32) -> (code: Int32, signal: Int32?) {
        let signalNumber = status & 0x7f
        if signalNumber == 0 {
            return ((status >> 8) & 0xff, nil)
        }
        return (128 + signalNumber, signalNumber)
    }

    static func readCapturedOutput(at url: URL, maxBytes: Int) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let data = ((try? handle.read(upToCount: maxBytes)) ?? nil) ?? Data()
        guard !data.isEmpty else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}

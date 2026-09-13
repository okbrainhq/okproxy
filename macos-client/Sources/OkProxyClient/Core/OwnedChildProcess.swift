import Darwin
import Foundation

/// Result of a supervised child, delivered only after `waitpid` confirms exit.
struct ChildExit {
    let exitCode: Int32
    let signal: Int32?
    let capturedOutput: String?
    let failureReason: String?

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
final class OwnedChildProcess {
    let id = UUID()
    let role: ProcessRole
    let executablePath: String
    let pid: pid_t
    let processGroupID: pid_t
    let captureURL: URL?

    private let stateLock = NSLock()
    private var confirmedExit: ChildExit?
    private var terminationRequested = false
    private var identityOwned = true
    private var waitFailure: Int32?

    var ownershipFailure: Int32? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return waitFailure
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

    /// Called off-main. WNOHANG keeps lock hold time bounded.
    func pollExit() -> Int32? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard identityOwned else { return nil }
        var status: Int32 = 0
        let waited = waitpid(pid, &status, WNOHANG)
        if waited == 0 || (waited == -1 && errno == EINTR) { return nil }
        identityOwned = false // invalidate under the SAME lock as signaling
        if waited == -1 {
            waitFailure = errno // no fabricated successful exit; retain gate
            return nil
        }
        let exit = PosixChildProcess.decode(status: status)
        guard exit.signal == nil else {
            waitFailure = ECHILD // helper died without a cleanup acknowledgement
            return nil
        }
        confirmedExit = ChildExit(exitCode: exit.code, signal: nil,
                                  capturedOutput: nil, failureReason: nil)
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

}

enum PosixChildProcess {
    struct Spawned {
        let pid: pid_t
        let captureURL: URL?
        let readFileDescriptor: Int32
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
        try check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK)))
        try check(posix_spawnattr_setpgroup(&attributes, 0))
        var mask = sigset_t()
        sigemptyset(&mask)
        // Pending control signals survive exec until the helper is ready.
        sigaddset(&mask, SIGTERM)
        sigaddset(&mask, SIGINT)
        sigaddset(&mask, SIGUSR1)
        try check(posix_spawnattr_setsigmask(&attributes, &mask))

        // Helper is shipped alongside the app executable; no shell interpolation.
        let program = URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent().appendingPathComponent("OkProxyProcessHelper").path
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
    /// `onExit` runs on a utility queue; callers hop to the main actor.
    static func monitor(
        child: OwnedChildProcess,
        captureURL: URL?,
        maxCapturedBytes: Int,
        onOwnershipFailure: @escaping (Int32) -> Void,
        onExit: @escaping (ChildExit) -> Void
    ) {
        DispatchQueue.global(qos: .utility).async {
            var status: Int32?
            while status == nil {
                status = child.pollExit()
                if let failure = child.ownershipFailure {
                    onOwnershipFailure(failure)
                    return // registry/gates remain retained; no success callback
                }
                if status == nil { usleep(20_000) }
            }

            let exit = decode(status: status!)
            let captured: String?
            if let captureURL {
                captured = readCapturedOutput(at: captureURL, maxBytes: maxCapturedBytes)
                try? FileManager.default.removeItem(at: captureURL)
            } else {
                captured = nil
            }
            onExit(ChildExit(
                exitCode: exit.code,
                signal: exit.signal,
                capturedOutput: captured,
                failureReason: nil
            ))
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

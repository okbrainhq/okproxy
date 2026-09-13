import AppKit
import Darwin
import Foundation

/// Cross-process single-instance guard for one state directory.
///
/// Dev and prod builds use different state directories, so they may coexist;
/// two copies of the *same* build (for example `open -n`) may not, because they
/// would share `UserDefaults`, the log file and the client child process.
///
/// The guard uses an advisory `flock` on `<state-dir>/app.lock`. The lock is
/// released automatically by the kernel when the process exits, including a
/// crash, so there is no stale-lock recovery problem. The guard never signals
/// or scans other processes: it only reports whether the lock is held.
final class SingleInstanceGuard {
    enum AcquireResult {
        case acquired
        case alreadyRunning
        case failed(String)
    }

    static let shared = SingleInstanceGuard()

    private var fileDescriptor: Int32 = -1
    private(set) var lockPath: String?

    private init() {}

    @discardableResult
    func acquire(stateDirectory: URL) -> AcquireResult {
        // AppModel may initialize before delegate launch callbacks. Repeated
        // acquisition must NOT unlock/relock an already-owned lifetime lease.
        if fileDescriptor >= 0 {
            return lockPath == stateDirectory.appendingPathComponent("app.lock").path
                ? .acquired : .failed("already guarding another state directory")
        }

        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(
                at: stateDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            return .failed("could not create \(stateDirectory.path): \(error.localizedDescription)")
        }

        let lockURL = stateDirectory.appendingPathComponent("app.lock")
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else {
            return .failed("could not open \(lockURL.path)")
        }

        if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
            fileDescriptor = descriptor
            lockPath = lockURL.path
            return .acquired
        }

        let lockError = errno
        close(descriptor)
        if lockError == EWOULDBLOCK {
            return .alreadyRunning
        }
        return .failed("could not lock \(lockURL.path) (errno \(lockError))")
    }

    func release() {
        guard fileDescriptor >= 0 else { return }
        // Close our reference only. Helpers inherit this descriptor, keeping
        // relaunch/recovery excluded until their cleanup finishes after a crash.
        close(fileDescriptor)
        fileDescriptor = -1
        lockPath = nil
    }

    /// Bring the already-running copy of this bundle to the front. Only other
    /// instances of the *same bundle identifier* are considered.
    @discardableResult
    static func activateExistingInstance(bundleIdentifier: String?) -> Bool {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        guard let identifier = bundleIdentifier ?? Bundle.main.bundleIdentifier else { return false }
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .filter { $0.processIdentifier != currentPID }
        guard let existing = candidates.first else { return false }
        return existing.activate(options: [.activateAllWindows])
    }
}

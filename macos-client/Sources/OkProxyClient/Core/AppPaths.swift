import Foundation

/// Single source of truth for every filesystem location the app touches.
///
/// The state directory name comes from the bundled `Info.plist`
/// (`AppStateDirectoryName`). Values coming from a plist/XML file are untrusted
/// input: a malformed name (`""`, `.`, `..`, `foo/bar`, `~/x`) must never be
/// allowed to escape the user's home directory, so `sanitizedDirectoryName`
/// rejects anything that is not a single plain directory component.
enum AppPaths {
    static let fallbackStateDirectoryName = ".okproxy-dev"
    private static let fallbackLogFileName = "client.log"

    static var bundleInfo: [String: Any] {
        Bundle.main.infoDictionary ?? [:]
    }

    static var appEnvironment: String {
        (bundleInfo["AppEnvironment"] as? String) ?? "dev"
    }

    static var rawStateDirectoryName: String {
        (bundleInfo["AppStateDirectoryName"] as? String) ?? fallbackStateDirectoryName
    }

    /// Only a single plain path component is accepted. Anything else (empty,
    /// dot components, separators, tilde expansion, control characters) falls
    /// back to the safe default instead of being used as a path.
    static func sanitizedDirectoryName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed != ".",
              trimmed != "..",
              !trimmed.contains("/"),
              !trimmed.contains("\\"),
              !trimmed.contains(":"),
              !trimmed.hasPrefix("~"),
              !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else {
            return fallbackStateDirectoryName
        }
        return trimmed
    }

    static var stateDirectoryName: String {
        sanitizedDirectoryName(rawStateDirectoryName)
    }

    static var stateDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(stateDirectoryName, isDirectory: true)
    }

    static var logsDirectory: URL {
        stateDirectory.appendingPathComponent("logs", isDirectory: true)
    }

    static var logFileURL: URL {
        logsDirectory.appendingPathComponent(fallbackLogFileName)
    }

    static var repoDirectory: URL {
        stateDirectory.appendingPathComponent("repo", isDirectory: true)
    }

    /// Run records written by `OkProxyProcessHelper` for supervised children.
    ///
    /// They are the only way the app can find a workload's process group again
    /// after its helper crashed, was killed externally, or had to be reclaimed
    /// by force, so "stop" stays possible no matter how the previous run ended.
    static var runDirectory: URL {
        stateDirectory.appendingPathComponent("run", isDirectory: true)
    }

    static var nodeRoot: URL {
        stateDirectory.appendingPathComponent("node", isDirectory: true)
    }

    static var nodeExecutable: URL {
        nodeRoot.appendingPathComponent("bin/node")
    }

    static var lockFileURL: URL {
        stateDirectory.appendingPathComponent("app.lock")
    }

    /// Create the state/log/run directories up front. Every writer (log store,
    /// node install, lock file, run records) can then assume its parent exists.
    static func ensureStateDirectories() {
        let fileManager = FileManager.default
        for directory in [stateDirectory, logsDirectory, runDirectory] {
            do {
                try fileManager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                // Best effort: the caller reports operational failures through
                // the log/UI instead of crashing during launch.
            }
        }
    }

    /// Best-effort append used before the LogStore exists (single-instance
    /// guard decisions happen before the SwiftUI model is constructed).
    static func appendLaunchNote(_ message: String, maximumBytes: UInt64 = 1_000_000) {
        ensureStateDirectories()
        let fileManager = FileManager.default
        let line = "[\(launchNoteFormatter.string(from: Date()))] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }

        var currentSize: UInt64 = 0
        if let attributes = try? fileManager.attributesOfItem(atPath: logFileURL.path),
           let number = attributes[.size] as? NSNumber {
            currentSize = number.uint64Value
        }
        if currentSize + UInt64(data.count) > maximumBytes {
            let rotated = logFileURL.appendingPathExtension("1")
            try? fileManager.removeItem(at: rotated)
            try? fileManager.moveItem(at: logFileURL, to: rotated)
        }

        if fileManager.fileExists(atPath: logFileURL.path) {
            guard let handle = try? FileHandle(forWritingTo: logFileURL) else { return }
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: logFileURL, options: .atomic)
        }
    }
}

private let launchNoteFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

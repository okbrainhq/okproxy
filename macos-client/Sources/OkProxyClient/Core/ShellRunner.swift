import Foundation

final class ShellRunner {
    static func run(_ executable: String, _ arguments: [String], cwd: String? = nil, log: @escaping @MainActor (String) -> Void, onExit: (@MainActor (Int32) -> Void)? = nil) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let output = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in log(output.trimmingCharacters(in: .newlines)) }
        }

        process.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in onExit?(proc.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            Task { @MainActor in
                log("Failed to run \(executable): \(error.localizedDescription)")
                onExit?(-1)
            }
        }
        return process
    }
}

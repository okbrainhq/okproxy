import Foundation

final class ShellRunner {
    static func run(_ executable: String, _ arguments: [String], cwd: String? = nil, log: @escaping @MainActor (String) -> Void, onExit: (@MainActor (Int32) -> Void)? = nil) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let pipe = Pipe()
        let logBuffer = ShellOutputBuffer(log: log)
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            logBuffer.append(String(decoding: data, as: UTF8.self))
        }

        process.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            logBuffer.flush()
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

private final class ShellOutputBuffer {
    private let queue = DispatchQueue(label: "OkProxyClient.ShellOutputBuffer")
    private let log: @MainActor (String) -> Void
    private var buffer = ""
    private var flushScheduled = false

    init(log: @escaping @MainActor (String) -> Void) {
        self.log = log
    }

    func append(_ output: String) {
        queue.async {
            self.buffer += output
            guard !self.flushScheduled else { return }
            self.flushScheduled = true
            self.queue.asyncAfter(deadline: .now() + .milliseconds(100)) {
                self.flushOnQueue()
            }
        }
    }

    func flush() {
        queue.sync {
            self.flushOnQueue()
        }
    }

    private func flushOnQueue() {
        let output = buffer.trimmingCharacters(in: .newlines)
        buffer.removeAll(keepingCapacity: true)
        flushScheduled = false
        guard !output.isEmpty else { return }
        Task { @MainActor [log] in
            log(output)
        }
    }
}

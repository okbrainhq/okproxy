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

        // Read the pipe on a background queue so the child process never blocks
        // on stdout/stderr writes when the main thread is busy rendering logs.
        // The previous approach used readabilityHandler (main run loop), which
        // could stall when LogStore.append + NSTextView re-layout took too long,
        // filling the 16 KB pipe buffer and freezing the Node.js event loop.
        let readQueue = DispatchQueue(label: "OkProxyClient.pipe-reader", qos: .utility)
        let readSource: DispatchSourceRead? = DispatchSource.makeReadSource(
            fileDescriptor: pipe.fileHandleForReading.fileDescriptor,
            queue: readQueue
        )

        if let readSource {
            readSource.setEventHandler { [pipe] in
                let data = pipe.fileHandleForReading.readData(ofLength: 65536)
                guard !data.isEmpty else {
                    readSource.cancel()
                    return
                }
                logBuffer.append(String(decoding: data, as: UTF8.self))
            }
            readSource.setCancelHandler { [pipe] in
                pipe.fileHandleForReading.closeFile()
            }
            readSource.resume()
        }

        process.terminationHandler = { proc in
            readSource?.cancel()
            logBuffer.flush()
            Task { @MainActor in onExit?(proc.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            readSource?.cancel()
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

import Darwin
import Foundation

final class ShellRunner {
    static func run(_ executable: String, _ arguments: [String], cwd: String? = nil, log: @escaping @MainActor (String) -> Void, onExit: (@MainActor (Int32) -> Void)? = nil) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let pipe = Pipe()
        let logBuffer = ShellOutputBuffer(log: log)
        let pipeReader = ShellPipeReader(pipe: pipe, logBuffer: logBuffer)
        process.standardOutput = pipe
        process.standardError = pipe

        // Read the pipe on a background queue so the child process never blocks
        // on stdout/stderr writes when the main thread is busy rendering logs.
        pipeReader.start()

        process.terminationHandler = { proc in
            pipeReader.stopAndDrain()
            logBuffer.flush()
            Task { @MainActor in onExit?(proc.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            pipeReader.stopAndDrain()
            Task { @MainActor in
                log("Failed to run \(executable): \(error.localizedDescription)")
                onExit?(-1)
            }
        }
        return process
    }
}

private final class ShellPipeReader {
    private let logBuffer: ShellOutputBuffer
    private let readQueue = DispatchQueue(label: "OkProxyClient.pipe-reader", qos: .utility)
    private let readSource: DispatchSourceRead
    private let fileDescriptor: Int32
    private var isCancelled = false

    init(pipe: Pipe, logBuffer: ShellOutputBuffer) {
        self.logBuffer = logBuffer
        self.fileDescriptor = pipe.fileHandleForReading.fileDescriptor
        self.readSource = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: readQueue)

        let currentFlags = fcntl(fileDescriptor, F_GETFL)
        if currentFlags >= 0 {
            _ = fcntl(fileDescriptor, F_SETFL, currentFlags | O_NONBLOCK)
        }

        readSource.setEventHandler { [weak self] in
            self?.readAvailableOnQueue()
        }
        readSource.setCancelHandler { [pipe] in
            pipe.fileHandleForReading.closeFile()
        }
    }

    func start() {
        readSource.resume()
    }

    func stopAndDrain() {
        readQueue.sync {
            readAvailableOnQueue()
            cancelOnQueue()
        }
    }

    private func readAvailableOnQueue() {
        guard !isCancelled else { return }

        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let bytesRead = buffer.withUnsafeMutableBytes { rawBuffer in
                Darwin.read(fileDescriptor, rawBuffer.baseAddress, rawBuffer.count)
            }

            if bytesRead > 0 {
                logBuffer.append(String(decoding: buffer[0..<bytesRead], as: UTF8.self))
                continue
            }

            if bytesRead == 0 {
                cancelOnQueue()
                return
            }

            if errno == EINTR {
                continue
            }

            if errno == EAGAIN || errno == EWOULDBLOCK {
                return
            }

            cancelOnQueue()
            return
        }
    }

    private func cancelOnQueue() {
        guard !isCancelled else { return }
        isCancelled = true
        readSource.cancel()
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

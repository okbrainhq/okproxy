import Darwin
import Foundation

enum ProcessRole: String {
    case client
    case setup
    case versionProbe
}

/// How a child's stdout/stderr is handled.
enum OutputMode {
    /// Streamed into the bounded log buffer (long-running setup / client).
    case stream(maxBufferedCharacters: Int)
    /// Captured to a private temp file, read once the child is reaped.
    case capture(maxBytes: Int)
}

enum ShellRunner {
    /// Spawn a supervised child in its own process group.
    ///
    /// Returns `nil` when the process could not be spawned; `onExit` is still
    /// invoked with a `ChildExit` carrying the failure reason, so callers have a
    /// single completion path.
    @discardableResult
    static func spawn(
        executable: String,
        arguments: [String],
        cwd: String? = nil,
        role: ProcessRole,
        environment: [String: String] = [:],
        output: OutputMode,
        log: @escaping @MainActor (String) -> Void = { _ in },
        onExit: @escaping @MainActor (ChildExit) -> Void
    ) -> OwnedChildProcess? {
        var captureOutput = false
        var maxCapturedBytes = 0
        var bufferCharacters = 0
        switch output {
        case .capture(let maxBytes):
            captureOutput = true
            maxCapturedBytes = max(maxBytes, 1024)
        case .stream(let maxBufferedCharacters):
            bufferCharacters = max(maxBufferedCharacters, 4096)
        }

        let spawned: PosixChildProcess.Spawned
        do {
            spawned = try PosixChildProcess.spawn(
                executable: executable,
                arguments: arguments,
                cwd: cwd,
                environment: environment,
                captureOutput: captureOutput
            )
        } catch let error as ChildSpawnError {
            let reason = error.message
            Task { @MainActor in
                log("Failed to run \(executable): \(reason)")
                onExit(.spawnFailure(reason))
            }
            return nil
        } catch {
            let reason = error.localizedDescription
            Task { @MainActor in
                log("Failed to run \(executable): \(reason)")
                onExit(.spawnFailure(reason))
            }
            return nil
        }

        var reader: ShellPipeReader?
        if !captureOutput, spawned.readFileDescriptor >= 0 {
            let decoder = IncrementalUTF8Decoder()
            let buffer = ShellOutputBuffer(maxCharacters: bufferCharacters, log: log)
            let pipeReader = ShellPipeReader(
                fileDescriptor: spawned.readFileDescriptor,
                decoder: decoder,
                logBuffer: buffer
            )
            pipeReader.start()
            reader = pipeReader
        }

        let handle = OwnedChildProcess(
            role: role,
            executablePath: executable,
            pid: spawned.pid,
            captureURL: spawned.captureURL
        )

        PosixChildProcess.monitor(
            child: handle,
            captureURL: spawned.captureURL,
            maxCapturedBytes: maxCapturedBytes,
            onOwnershipFailure: { code in
                reader?.stopAndDrain()
                Task { @MainActor in
                    log("Child ownership failed (errno \(code)); operation gate retained. No further signals will be sent.")
                }
            }
        ) { result in
            reader?.stopAndDrain()
            Task { @MainActor in
                // Ownership is released only now, after waitpid confirmed the exit.
                onExit(result)
            }
        }

        return handle
    }
}

/// Reads a child's pipe on a background queue and feeds the log buffer.
private final class ShellPipeReader {
    private static let readBufferSize = 65_536

    private let logBuffer: ShellOutputBuffer
    private let decoder: IncrementalUTF8Decoder
    private let readQueue = DispatchQueue(label: "OkProxyClient.pipe-reader", qos: .utility)
    private let readSource: DispatchSourceRead
    private let fileDescriptor: Int32
    private var scratch = [UInt8](repeating: 0, count: ShellPipeReader.readBufferSize)
    private var isFinished = false

    init(fileDescriptor: Int32, decoder: IncrementalUTF8Decoder, logBuffer: ShellOutputBuffer) {
        self.fileDescriptor = fileDescriptor
        self.decoder = decoder
        self.logBuffer = logBuffer
        self.readSource = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: readQueue)

        let currentFlags = fcntl(fileDescriptor, F_GETFL)
        if currentFlags >= 0 {
            _ = fcntl(fileDescriptor, F_SETFL, currentFlags | O_NONBLOCK)
        }

        readSource.setEventHandler { [weak self] in
            self?.readAvailableOnQueue()
        }
        readSource.setCancelHandler { [fileDescriptor] in
            close(fileDescriptor)
        }
    }

    func start() {
        readSource.resume()
    }

    /// Drain whatever is still buffered, flush the decoder, then close the fd.
    func stopAndDrain() {
        readQueue.sync {
            self.readAvailableOnQueue()
            self.finishOnQueue()
        }
    }

    private func readAvailableOnQueue() {
        guard !isFinished else { return }
        // Bounded per event, including failure cleanup with a still-open pipe.
        for _ in 0..<16 {
            guard !isFinished else { return }
            let count = scratch.withUnsafeMutableBytes { rawBuffer -> Int in
                guard let base = rawBuffer.baseAddress else { return 0 }
                return Darwin.read(fileDescriptor, base, rawBuffer.count)
            }

            if count > 0 {
                let text = decoder.decode(scratch[0..<count])
                if !text.isEmpty { logBuffer.append(text) }
                continue
            }

            if count == 0 {
                finishOnQueue()
                return
            }

            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            if errno == EINTR { continue }
            finishOnQueue()
            return
        }
    }

    private func finishOnQueue() {
        guard !isFinished else { return }
        isFinished = true
        logBuffer.append(decoder.flush())
        logBuffer.flush()
        readSource.cancel()
    }
}

/// Coalesces child output on a serial queue with explicit, bounded overflow.
private final class ShellOutputBuffer {
    private let queue = DispatchQueue(label: "OkProxyClient.ShellOutputBuffer")
    private let log: @MainActor (String) -> Void
    private let maxBytes: Int

    private var buffer = Data()
    private var droppedBytes = 0
    private var deliveryInFlight = false
    private var flushScheduled = false

    init(maxCharacters: Int, log: @escaping @MainActor (String) -> Void) {
        // Legacy parameter name; the limit is now UTF-8 BYTES, not graphemes.
        self.maxBytes = max(maxCharacters, 4096)
        self.log = log
    }

    func append(_ text: String) {
        guard !text.isEmpty else { return }
        // Synchronous bounded append applies backpressure to this pipe reader.
        // There is no per-chunk async closure backlog, even with a stalled UI.
        queue.sync {
            appendOnQueue(text)
        }
    }

    func flush() {
        queue.sync {
            self.deliverOnQueue()
        }
    }

    private func appendOnQueue(_ text: String) {
        let bytes = text.utf8
        let incomingCount = bytes.count
        // Never allocate the full incoming string as Data. Keep only a bounded
        // suffix; then discard leading UTF-8 continuation bytes at the cut.
        let incoming = Data(bytes.suffix(maxBytes))
        recordDropped(incomingCount - incoming.count)
        buffer.append(incoming) // transient storage <= 2 * maxBytes
        if buffer.count > maxBytes {
            let overflow = buffer.count - maxBytes
            buffer.removeFirst(overflow)
            recordDropped(overflow)
        }
        while let first = buffer.first, first & 0xC0 == 0x80 {
            buffer.removeFirst()
            recordDropped(1)
        }
        scheduleFlushOnQueue()
    }

    private func recordDropped(_ count: Int) {
        let (sum, overflow) = droppedBytes.addingReportingOverflow(count)
        droppedBytes = overflow ? Int.max : sum
    }

    private func scheduleFlushOnQueue() {
        guard !flushScheduled, !deliveryInFlight else { return }
        flushScheduled = true
        queue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in
            self?.flushScheduled = false
            self?.deliverOnQueue()
        }
    }

    /// At most ONE delivery Task may be outstanding at a time; anything that
    /// arrives meanwhile stays buffered and is drained when it completes.
    private func deliverOnQueue() {
        guard !deliveryInFlight else { return }

        var output = String(decoding: buffer, as: UTF8.self)
        buffer = Data()
        if droppedBytes > 0 {
            output = "[okproxy: \(droppedBytes) earlier UTF-8 bytes were dropped from the log buffer]\n" + output
            droppedBytes = 0
        }
        guard !output.isEmpty else { return }
        // One bounded payload (maxBytes + fixed-size counter marker) in flight.

        deliveryInFlight = true
        Task { @MainActor [weak self, log] in
            log(output)
            self?.queue.async { [weak self] in
                self?.deliveryFinishedOnQueue()
            }
        }
    }

    private func deliveryFinishedOnQueue() {
        deliveryInFlight = false
        if !buffer.isEmpty || droppedBytes > 0 {
            scheduleFlushOnQueue()
        }
    }
}

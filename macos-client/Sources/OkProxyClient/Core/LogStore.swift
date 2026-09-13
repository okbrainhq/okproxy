import Combine
import Foundation

struct LogEntry: Identifiable, Equatable {
    let id: Int
    let text: String
}

/// Bounded, main-thread-affine log store with off-main disk writes.
///
/// Guarantees:
/// - `entries` is only mutated on the main thread (all callers are main-actor).
/// - All disk I/O (append, rotation, truncate) runs on a private serial queue,
///   so a slow disk never stalls SwiftUI rendering.
/// - History is bounded both by entry count and by total characters, so a few
///   pathological lines cannot blow up memory; oversized single lines are
///   truncated with a marker.
/// - Log reads use `String(decoding:as:)` so one stray byte cannot discard the
///   whole tail section.
final class LogStore: ObservableObject {
    @Published private(set) var entries: [LogEntry] = []
    @Published private(set) var lastEntryID: Int?

    private let fileURL: URL
    private let maxBytes: UInt64
    private let rotatedFileCount: Int
    private let maxEntries: Int
    private let maxTotalCharacters: Int
    private let maxLineCharacters: Int
    private let maxPayloadCharacters: Int
    private let maxQueuedWrites: Int
    private let initialLoadBytes: UInt64
    private let fileManager = FileManager.default
    private let diskQueue = DispatchQueue(label: "OkProxyClient.LogStore.disk", qos: .utility)

    /// Main-thread-confined: queued disk writes and dropped characters.
    private var queuedWrites = 0
    private var droppedCharacters = 0

    /// Main-thread-confined counter used to drop memory updates that were
    /// queued before a `clear()`.
    private var generation = 0
    private var nextID = 0

    init(
        fileURL: URL,
        maxBytes: UInt64 = 1_000_000,
        rotatedFileCount: Int = 4,
        maxEntries: Int = 2_000,
        maxTotalCharacters: Int = 1_500_000,
        maxLineCharacters: Int = 8_192,
        maxPayloadCharacters: Int = 131_072,
        maxQueuedWrites: Int = 8,
        initialLoadBytes: UInt64 = 256_000
    ) {
        self.fileURL = fileURL
        self.maxBytes = maxBytes
        self.rotatedFileCount = rotatedFileCount
        self.maxEntries = maxEntries
        self.maxTotalCharacters = maxTotalCharacters
        self.maxLineCharacters = maxLineCharacters
        self.maxPayloadCharacters = max(maxPayloadCharacters, 4_096)
        self.maxQueuedWrites = max(maxQueuedWrites, 1)
        self.initialLoadBytes = initialLoadBytes
        loadFromDisk()
    }

    convenience init() {
        let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("okproxy-client.log")
        self.init(fileURL: fallback)
    }

    var isEmpty: Bool {
        entries.isEmpty
    }

    var entryLimit: Int {
        maxEntries
    }

    private func beginQueuedWrite() -> Bool {
        guard queuedWrites < maxQueuedWrites else { return false }
        queuedWrites += 1
        return true
    }

    private func endQueuedWrite() {
        if queuedWrites > 0 { queuedWrites -= 1 }
    }

    private func recordDroppedCharacters(_ count: Int) {
        droppedCharacters += count
    }

    private func takeOverflowNotice() -> String? {
        guard droppedCharacters > 0 else { return nil }
        let notice = "[okproxy: dropped \(droppedCharacters) characters of log output because the log queue was saturated]"
        droppedCharacters = 0
        return notice
    }

    func append(_ output: String) {
        let trimmed = output.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else { return }

        // Cap BEFORE queuing: neither the queue, the closure payload, nor the
        // disk write may grow with the producer's rate.
        var payload = trimmed
        if payload.count > maxPayloadCharacters {
            let dropped = payload.count - maxPayloadCharacters
            payload = String(payload.prefix(maxPayloadCharacters))
                + "\n…[okproxy: dropped \(dropped) characters from one log payload]"
            recordDroppedCharacters(dropped)
        }

        guard beginQueuedWrite() else {
            // Explicit overflow instead of an unbounded backlog.
            recordDroppedCharacters(payload.count)
            return
        }

        let currentGeneration = generation
        let overflowNotice = takeOverflowNotice()
        diskQueue.async { [weak self] in
            guard let self else { return }
            var payloadForDisk = payload
            if let overflowNotice {
                payloadForDisk = "\(overflowNotice)\n\(payloadForDisk)"
            }
            let formatted = self.format(payloadForDisk)
            let failure = self.appendToDisk(formatted.diskEntry)

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.endQueuedWrite()
                guard self.generation == currentGeneration else { return }
                self.appendInMemory(formatted.memoryLines)
                if let failure {
                    self.appendInMemory(["\(logTimestamp()) Failed to write log file: \(failure)"])
                }
            }
        }
    }

    func clear() {
        generation += 1
        entries.removeAll(keepingCapacity: true)
        lastEntryID = nil

        let url = fileURL
        let rotationCount = rotatedFileCount
        let manager = fileManager
        diskQueue.async {
            try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? "".write(to: url, atomically: true, encoding: .utf8)
            guard rotationCount > 0 else { return }
            for index in 1...rotationCount {
                let rotated = URL(fileURLWithPath: "\(url.path).\(index)")
                if manager.fileExists(atPath: rotated.path) {
                    try? manager.removeItem(at: rotated)
                }
            }
        }
    }

    // MARK: - Formatting (runs on the disk queue)

    private func format(_ output: String) -> (diskEntry: String, memoryLines: [String]) {
        let stamp = logTimestamp()
        let rawLines = output.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        guard !rawLines.isEmpty else { return ("", []) }

        var diskEntry = ""
        diskEntry.reserveCapacity(output.count + rawLines.count * (stamp.count + 4))

        var memoryLines: [String] = []
        let memoryLimit = max(0, maxEntries)
        let memoryStartIndex = max(0, rawLines.count - memoryLimit)
        memoryLines.reserveCapacity(min(memoryLimit, rawLines.count))

        for (index, rawLine) in rawLines.enumerated() {
            let entry = "[\(stamp)] \(String(rawLine))"
            diskEntry.append(entry)
            diskEntry.append("\n")
            if index >= memoryStartIndex {
                memoryLines.append(entry)
            }
        }
        return (diskEntry, memoryLines)
    }

    // MARK: - Disk (runs on the disk queue)

    private func appendToDisk(_ entry: String) -> String? {
        guard !entry.isEmpty else { return nil }
        do {
            try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            rotateIfNeeded(extraBytes: UInt64(entry.utf8.count))
            if fileManager.fileExists(atPath: fileURL.path), let handle = try? FileHandle(forWritingTo: fileURL) {
                try handle.seekToEnd()
                try handle.write(contentsOf: Data(entry.utf8))
                try handle.close()
            } else {
                try Data(entry.utf8).write(to: fileURL, options: .atomic)
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private func rotateIfNeeded(extraBytes: UInt64) {
        var currentSize: UInt64 = 0
        if let attributes = try? fileManager.attributesOfItem(atPath: fileURL.path),
           let number = attributes[.size] as? NSNumber {
            currentSize = number.uint64Value
        }
        guard currentSize + extraBytes > maxBytes else { return }
        guard rotatedFileCount > 0 else {
            try? fileManager.removeItem(at: fileURL)
            return
        }

        let oldest = rotatedURL(index: rotatedFileCount)
        if fileManager.fileExists(atPath: oldest.path) {
            try? fileManager.removeItem(at: oldest)
        }
        if rotatedFileCount > 1 {
            for index in stride(from: rotatedFileCount - 1, through: 1, by: -1) {
                let source = rotatedURL(index: index)
                let destination = rotatedURL(index: index + 1)
                if fileManager.fileExists(atPath: source.path) {
                    try? fileManager.moveItem(at: source, to: destination)
                }
            }
        }

        let first = rotatedURL(index: 1)
        if fileManager.fileExists(atPath: first.path) {
            try? fileManager.removeItem(at: first)
        }
        if fileManager.fileExists(atPath: fileURL.path) {
            try? fileManager.moveItem(at: fileURL, to: first)
        }
    }

    private func rotatedURL(index: Int) -> URL {
        URL(fileURLWithPath: "\(fileURL.path).\(index)")
    }

    // MARK: - Load (main thread, launch time)

    private func loadFromDisk() {
        guard let initialLog = readInitialLogData() else { return }
        var saved = String(decoding: initialLog.data, as: UTF8.self)
        if initialLog.isPartial, let firstNewline = saved.firstIndex(of: "\n") {
            saved = String(saved[saved.index(after: firstNewline)...])
        }

        var lines = saved.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.last == "" { lines.removeLast() }
        if lines.count > maxEntries {
            lines = Array(lines.suffix(max(0, maxEntries)))
        }
        appendInMemory(lines)
    }

    private func readInitialLogData() -> (data: Data, isPartial: Bool)? {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? handle.close() }

        do {
            let size = try handle.seekToEnd()
            let offset = size > initialLoadBytes ? size - initialLoadBytes : 0
            try handle.seek(toOffset: offset)
            return (try handle.readToEnd() ?? Data(), offset > 0)
        } catch {
            return nil
        }
    }

    // MARK: - Memory (main thread only)

    private func appendInMemory(_ lines: [String]) {
        guard !lines.isEmpty, maxEntries > 0, maxTotalCharacters > 0 else { return }

        let boundedLines = lines.map { line -> String in
            guard line.count > maxLineCharacters else { return line }
            let head = line.prefix(maxLineCharacters)
            return "\(head)…[truncated \(line.count - maxLineCharacters) characters]"
        }
        let storableLines = boundedLines.count > maxEntries ? Array(boundedLines.suffix(maxEntries)) : boundedLines

        var updatedEntries = entries
        updatedEntries.reserveCapacity(min(maxEntries, updatedEntries.count + storableLines.count))

        for line in storableLines {
            nextID += 1
            updatedEntries.append(LogEntry(id: nextID, text: line))
        }

        if updatedEntries.count > maxEntries {
            updatedEntries.removeFirst(updatedEntries.count - maxEntries)
        }

        var characters = updatedEntries.reduce(0) { $0 + $1.text.count }
        while characters > maxTotalCharacters, updatedEntries.count > 1 {
            let removed = updatedEntries.removeFirst()
            characters -= removed.text.count
        }

        entries = updatedEntries
        lastEntryID = updatedEntries.last?.id
    }
}

private func logTimestamp() -> String {
    logTimestampFormatter.string(from: Date())
}

private let logTimestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

import Foundation

struct LogEntry: Identifiable, Equatable {
    let id: Int
    let text: String
}

@MainActor
final class LogStore: ObservableObject {
    @Published private(set) var entries: [LogEntry] = []
    @Published private(set) var lastEntryID: Int?

    private let fileURL: URL
    private let maxBytes: UInt64
    private let rotatedFileCount: Int
    private let maxEntries: Int
    private let initialLoadBytes: UInt64
    private let fileManager = FileManager.default
    private let timestampFormatter = ISO8601DateFormatter()
    private var nextID = 0

    init(fileURL: URL, maxBytes: UInt64 = 1_000_000, rotatedFileCount: Int = 4, maxEntries: Int = 2_000, initialLoadBytes: UInt64 = 256_000) {
        self.fileURL = fileURL
        self.maxBytes = maxBytes
        self.rotatedFileCount = rotatedFileCount
        self.maxEntries = maxEntries
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

    func append(_ output: String) {
        let trimmedOutput = output.trimmingCharacters(in: .newlines)
        guard !trimmedOutput.isEmpty else { return }

        let stamp = timestampFormatter.string(from: Date())
        let rawLines = trimmedOutput.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        guard !rawLines.isEmpty else { return }

        var diskEntry = ""
        diskEntry.reserveCapacity(trimmedOutput.count + rawLines.count * (stamp.count + 4))

        var memoryLines: [String] = []
        let memoryLimit = max(0, maxEntries)
        memoryLines.reserveCapacity(min(memoryLimit, rawLines.count))
        let memoryStartIndex = max(0, rawLines.count - memoryLimit)

        for (index, rawLine) in rawLines.enumerated() {
            let entry = "[\(stamp)] \(String(rawLine))"
            diskEntry.append(entry)
            diskEntry.append("\n")
            if index >= memoryStartIndex {
                memoryLines.append(entry)
            }
        }

        appendInMemory(memoryLines)
        appendToDisk(diskEntry)
    }

    func clear() {
        entries.removeAll(keepingCapacity: true)
        lastEntryID = nil
        try? fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? "".write(to: fileURL, atomically: true, encoding: .utf8)
        for index in 1...rotatedFileCount {
            let rotated = rotatedURL(index: index)
            if fileManager.fileExists(atPath: rotated.path) {
                try? fileManager.removeItem(at: rotated)
            }
        }
    }

    private func loadFromDisk() {
        guard let initialLog = readInitialLogData(), var saved = String(data: initialLog.data, encoding: .utf8) else { return }
        if initialLog.isPartial, let firstNewline = saved.firstIndex(of: "\n") {
            saved = String(saved[saved.index(after: firstNewline)...])
        }

        var lines = saved.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.last == "" { lines.removeLast() }
        if lines.count > maxEntries {
            lines = Array(lines.suffix(maxEntries))
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

    private func appendInMemory(_ lines: [String]) {
        guard !lines.isEmpty, maxEntries > 0 else { return }
        let storableLines = lines.count > maxEntries ? Array(lines.suffix(maxEntries)) : lines

        var updatedEntries = entries
        updatedEntries.reserveCapacity(min(maxEntries, updatedEntries.count + storableLines.count))

        for line in storableLines {
            nextID += 1
            updatedEntries.append(LogEntry(id: nextID, text: line))
        }

        if updatedEntries.count > maxEntries {
            updatedEntries.removeFirst(updatedEntries.count - maxEntries)
        }

        entries = updatedEntries
        lastEntryID = updatedEntries.last?.id
    }

    private func appendToDisk(_ entry: String) {
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
        } catch {
            let stamp = timestampFormatter.string(from: Date())
            appendInMemory(["[\(stamp)] Failed to write log file: \(error.localizedDescription)"])
        }
    }

    private func rotateIfNeeded(extraBytes: UInt64) {
        let currentSize = ((try? fileManager.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.uint64Value) ?? 0
        guard currentSize + extraBytes > maxBytes else { return }

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
}

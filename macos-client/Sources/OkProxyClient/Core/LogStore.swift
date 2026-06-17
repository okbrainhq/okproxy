import Foundation

@MainActor
final class LogStore: ObservableObject {
    @Published var text: String = ""

    private let fileURL: URL
    private let maxBytes: UInt64
    private let rotatedFileCount: Int
    private let fileManager = FileManager.default

    init(fileURL: URL, maxBytes: UInt64 = 1_000_000, rotatedFileCount: Int = 4) {
        self.fileURL = fileURL
        self.maxBytes = maxBytes
        self.rotatedFileCount = rotatedFileCount
        loadFromDisk()
    }

    convenience init() {
        let fallback = FileManager.default.temporaryDirectory.appendingPathComponent("okproxy-client.log")
        self.init(fileURL: fallback)
    }

    func append(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let entry = "[\(stamp)] \(line)\n"
        text += entry
        appendToDisk(entry)
    }

    func clear() {
        text = ""
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
        guard let data = try? Data(contentsOf: fileURL), let saved = String(data: data, encoding: .utf8) else { return }
        text = saved
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
            text += "[\(ISO8601DateFormatter().string(from: Date()))] Failed to write log file: \(error.localizedDescription)\n"
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

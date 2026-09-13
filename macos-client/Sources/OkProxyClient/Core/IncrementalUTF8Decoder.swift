import Foundation

/// Incremental UTF-8 decoder for streamed child-process output.
///
/// A `read(2)` on a pipe can split a multi-byte UTF-8 scalar (or a log line) at
/// any byte boundary. Decoding each chunk independently with
/// `String(decoding:as:)` replaces the split scalar with U+FFFD and corrupts the
/// visible log text, so the decoder holds back the trailing incomplete scalar
/// until the following chunk completes it.
///
/// Invalid sequences are still decoded with the standard replacement character
/// and are never carried over, so the pending buffer can hold at most the 3
/// bytes of a maximally incomplete scalar.
final class IncrementalUTF8Decoder {
    private var pending: [UInt8] = []

    var hasPendingBytes: Bool { !pending.isEmpty }

    func decode(_ bytes: ArraySlice<UInt8>) -> String {
        guard !bytes.isEmpty else { return "" }

        var combined: [UInt8]
        if pending.isEmpty {
            combined = Array(bytes)
        } else {
            combined = pending
            combined.append(contentsOf: bytes)
            pending.removeAll(keepingCapacity: true)
        }

        let incompleteCount = Self.incompleteSuffixCount(in: combined)
        if incompleteCount > 0 {
            pending = Array(combined.suffix(incompleteCount))
            combined.removeLast(incompleteCount)
        }

        guard !combined.isEmpty else { return "" }
        return String(decoding: combined, as: UTF8.self)
    }

    /// Flush any bytes that can never be completed (end of stream).
    func flush() -> String {
        guard !pending.isEmpty else { return "" }
        let leftover = pending
        pending.removeAll(keepingCapacity: true)
        return String(decoding: leftover, as: UTF8.self)
    }

    /// Number of trailing bytes that form an incomplete (but potentially valid)
    /// UTF-8 scalar, i.e. the count of bytes that must be withheld.
    private static func incompleteSuffixCount(in bytes: [UInt8]) -> Int {
        let count = bytes.count
        var index = count - 1
        var continuationBytes = 0

        while index >= 0 && continuationBytes < 3 {
            let byte = bytes[index]

            if byte & 0xC0 == 0x80 {
                continuationBytes += 1
                index -= 1
                continue
            }

            if byte & 0x80 == 0 {
                // ASCII at the end: the scalar is complete.
                return 0
            }

            let expectedLength: Int
            switch byte {
            case 0xC2...0xDF: expectedLength = 2
            case 0xE0...0xEF: expectedLength = 3
            case 0xF0...0xF4: expectedLength = 4
            default:
                // Invalid lead byte (0x80...0xC1, 0xF5...0xFF): let the
                // standard decoder emit the replacement character.
                return 0
            }

            let available = count - index
            return available < expectedLength ? available : 0
        }

        // All trailing bytes were continuation bytes without a lead byte in
        // reach: they are invalid, decode them now.
        return 0
    }
}

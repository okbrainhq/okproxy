import Foundation

@MainActor
final class LogStore: ObservableObject {
    @Published var text: String = ""

    func append(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        text += "[\(stamp)] \(line)\n"
    }

    func clear() {
        text = ""
    }
}

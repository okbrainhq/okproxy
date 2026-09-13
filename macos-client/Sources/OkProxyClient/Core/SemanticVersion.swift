import Foundation

/// Full `major.minor.patch` version handling.
///
/// A check that only compares the major component reports "up to date" while a
/// newer patch or minor release is available, and must never be used to decide
/// whether to install. `updateKind` classifies the difference so callers can
/// distinguish major/minor/patch updates.
struct SemanticVersion: Comparable, CustomStringConvertible, Equatable {
    let major: Int
    let minor: Int
    let patch: Int
    let prerelease: String?

    init?(_ raw: String) {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = value.first, first == "v" || first == "V" {
            value.removeFirst()
        }
        guard !value.isEmpty else { return nil }

        let components = value.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = components[0].split(separator: ".", omittingEmptySubsequences: false)
        guard numbers.count == 3,
              let major = Int(numbers[0]),
              let minor = Int(numbers[1]),
              let patch = Int(numbers[2]),
              major >= 0, minor >= 0, patch >= 0
        else { return nil }

        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = components.count > 1 && !components[1].isEmpty ? String(components[1]) : nil
    }

    var description: String {
        var value = "\(major).\(minor).\(patch)"
        if let prerelease { value += "-\(prerelease)" }
        return value
    }

    static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil): return false
        case (nil, _): return false
        case (_, nil): return true
        case let (left?, right?): return left < right
        }
    }
}

enum UpdateKind: String {
    case none
    case patch
    case minor
    case major

    var summary: String {
        switch self {
        case .none: return "already up to date"
        case .patch: return "patch update available"
        case .minor: return "minor update available"
        case .major: return "major update available"
        }
    }
}

extension SemanticVersion {
    /// Compares the full version, not just the major component.
    static func updateKind(installed: SemanticVersion, latest: SemanticVersion) -> UpdateKind {
        guard latest > installed else { return .none }
        if latest.major != installed.major { return .major }
        if latest.minor != installed.minor { return .minor }
        return .patch
    }
}

/// Parses the official Node.js release index (`https://nodejs.org/dist/index.json`).
enum NodeReleaseCatalog {
    enum LTSValue: Decodable {
        case notLTS
        case name(String)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let isLTS = try? container.decode(Bool.self) {
                self = isLTS ? .name("LTS") : .notLTS
                return
            }
            if let name = try? container.decode(String.self), !name.isEmpty {
                self = .name(name)
                return
            }
            self = .notLTS
        }

        var isLTS: Bool {
            if case .name = self { return true }
            return false
        }
    }

    struct Release: Decodable {
        let version: String
        let lts: LTSValue

        enum CodingKeys: String, CodingKey {
            case version
            case lts
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            version = try container.decode(String.self, forKey: .version)
            lts = (try? container.decode(LTSValue.self, forKey: .lts)) ?? .notLTS
        }
    }

    /// Highest LTS version in the index, chosen by semantic comparison rather
    /// than trusting the document order.
    static func latestLTS(from data: Data) throws -> SemanticVersion? {
        let releases = try JSONDecoder().decode([Release].self, from: data)
        return releases
            .filter { $0.lts.isLTS }
            .compactMap { SemanticVersion($0.version) }
            .max()
    }

    static func fetchIndexData(timeout: TimeInterval = 10) async throws -> Data {
        guard let url = URL(string: "https://nodejs.org/dist/index.json") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadRevalidatingCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return data
    }
}

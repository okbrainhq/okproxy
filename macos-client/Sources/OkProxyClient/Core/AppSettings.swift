import Foundation

/// App configuration with tolerant decoding.
///
/// The previous implementation used a plain synthesized `Codable`: a single
/// unknown/missing/mistyped key made the *whole* decode fail, silently resetting
/// every setting to defaults. Decoding is now per-key with defaults, so config
/// from an older/newer build degrades gracefully instead of being wiped.
struct AppSettings: Codable, Equatable {
    static let repoURL = "https://github.com/okbrainhq/okproxy"

    var branchName: String = "main"

    var server: String = "localhost:9443"
    var target: String = "localhost:3000"
    var clientKeyPath: String = ""
    var clientCertPath: String = ""
    var caCertPath: String = ""
    var multipath: Bool = false
    var preserveHost: Bool = false
    var domainsText: String = ""
    var startClientAutomatically: Bool = false

    static let defaultsKey = "OkProxyClient.settings.v1"

    init() {}

    private enum CodingKeys: String, CodingKey {
        case branchName, server, target, clientKeyPath, clientCertPath, caCertPath
        case multipath, preserveHost, domainsText, startClientAutomatically
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        branchName = Self.decode(container, .branchName, branchName)
        server = Self.decode(container, .server, server)
        target = Self.decode(container, .target, target)
        clientKeyPath = Self.decode(container, .clientKeyPath, clientKeyPath)
        clientCertPath = Self.decode(container, .clientCertPath, clientCertPath)
        caCertPath = Self.decode(container, .caCertPath, caCertPath)
        multipath = Self.decode(container, .multipath, multipath)
        preserveHost = Self.decode(container, .preserveHost, preserveHost)
        domainsText = Self.decode(container, .domainsText, domainsText)
        startClientAutomatically = Self.decode(container, .startClientAutomatically, startClientAutomatically)
    }

    private static func decode<T: Decodable>(
        _ container: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys,
        _ fallback: T
    ) -> T {
        // `try?` already flattens the optional, so a bound `value` is non-optional
        // (a second `??` here would be dead code).
        guard let value = try? container.decodeIfPresent(T.self, forKey: key) else { return fallback }
        return value
    }

    static func load() -> AppSettings {
        loadResult().settings
    }

    /// Loads settings and reports non-fatal corruption so the caller can log it.
    /// Defaults are returned but are not persisted until the user changes
    /// something, so a corrupt blob is not silently overwritten at launch.
    static func loadResult() -> (settings: AppSettings, warning: String?) {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey) else {
            return (AppSettings(), nil)
        }
        do {
            return (try JSONDecoder().decode(AppSettings.self, from: data), nil)
        } catch {
            return (AppSettings(), "Saved settings could not be read (\(error.localizedDescription)); using defaults.")
        }
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }
}

extension String {
    var expandedTildePath: String {
        if self == "~" { return FileManager.default.homeDirectoryForCurrentUser.path }
        if hasPrefix("~/") {
            return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(dropFirst(2))).path
        }
        return self
    }

    var bashQuoted: String {
        "'" + replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

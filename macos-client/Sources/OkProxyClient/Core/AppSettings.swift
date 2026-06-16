import Foundation

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

    static let defaultsKey = "OkProxyClient.settings.v1"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let settings = try? JSONDecoder().decode(AppSettings.self, from: data) else {
            return AppSettings()
        }
        return settings
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

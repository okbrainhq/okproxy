import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var settings: AppSettings {
        didSet { settings.save() }
    }
    let logs: LogStore
    @Published var isSettingUp = false
    @Published var isRunningClient = false
    @Published var installedNodeVersion: String = "Not installed"
    @Published var isNodeSetup = false
    @Published var isRepoSetup = false

    private var setupProcess: Process?
    private var clientProcess: Process?
    private var nodeVersionTask: Task<Void, Never>?

    init() {
        settings = AppSettings.load()
        logs = LogStore(fileURL: Self.defaultStateDirectory.appendingPathComponent("logs/client.log"))
        refreshInstallStatus()
        logs.append("App launched (\(appEnvironment))")
        if settings.startClientAutomatically {
            Task { @MainActor in
                await Task.yield()
                self.startClient()
            }
        }
    }

    static var defaultStateDirectory: URL {
        let name = Bundle.main.object(forInfoDictionaryKey: "AppStateDirectoryName") as? String ?? ".okproxy-dev"
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(name)
    }

    var appEnvironment: String {
        Bundle.main.object(forInfoDictionaryKey: "AppEnvironment") as? String ?? "dev"
    }

    var isDevBuild: Bool { appEnvironment == "dev" }

    var stateDirectoryName: String {
        Bundle.main.object(forInfoDictionaryKey: "AppStateDirectoryName") as? String ?? ".okproxy-dev"
    }

    var stateDirectory: URL {
        Self.defaultStateDirectory
    }

    var logFilePath: String {
        stateDirectory.appendingPathComponent("logs/client.log").path
    }

    var resolvedRepoPath: String {
        stateDirectory.appendingPathComponent("repo").path
    }

    var resolvedNodePath: String {
        localNodeRoot.appendingPathComponent("bin/node").path
    }

    var localNodeRoot: URL {
        stateDirectory.appendingPathComponent("node")
    }

    func chooseFile(assign: @escaping (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.message = "Hidden files and folders are visible so keys inside dot-directories can be selected."
        if panel.runModal() == .OK, let url = panel.url {
            assign(url.path)
        }
    }

    func refreshInstallStatus() {
        let fileManager = FileManager.default
        let nodePath = resolvedNodePath
        isNodeSetup = fileManager.isExecutableFile(atPath: nodePath)
        isRepoSetup = fileManager.fileExists(atPath: URL(fileURLWithPath: resolvedRepoPath).appendingPathComponent(".git").path)

        nodeVersionTask?.cancel()
        guard isNodeSetup else {
            installedNodeVersion = "Not installed"
            return
        }

        installedNodeVersion = "Checking…"
        nodeVersionTask = Task(priority: .utility) { [weak self, nodePath] in
            let version = await Self.nodeVersionStringAsync(atPath: nodePath)
            guard !Task.isCancelled, let self, self.resolvedNodePath == nodePath else { return }
            self.installedNodeVersion = version
        }
    }

    func cloneRepo() {
        guard !isSettingUp, validateBranch() else { return }
        isSettingUp = true
        logs.append("Cloning repository into \(resolvedRepoPath) on branch \(settings.branchName)")
        let repoPath = resolvedRepoPath.bashQuoted
        let repoParent = stateDirectory.path.bashQuoted
        let branch = settings.branchName.bashQuoted
        let repoURL = AppSettings.repoURL.bashQuoted
        let script = """
        set -euo pipefail
        mkdir -p \(repoParent)
        if [ -d \(repoPath)/.git ]; then
          echo "Repository already exists; switching/updating branch instead."
          cd \(repoPath)
          git fetch origin \(branch)
          git checkout \(branch)
          git pull --ff-only origin \(branch)
        else
          git clone --branch \(branch) \(repoURL) \(repoPath)
        fi
        """
        runSetupScript(script, label: "Clone repo")
    }

    func updateRepo() {
        guard !isSettingUp, validateBranch() else { return }
        isSettingUp = true
        logs.append("Updating repository at \(resolvedRepoPath) and switching to branch \(settings.branchName)")
        let repoPath = resolvedRepoPath.bashQuoted
        let branch = settings.branchName.bashQuoted
        let script = """
        set -euo pipefail
        test -d \(repoPath)/.git
        cd \(repoPath)
        git fetch origin \(branch)
        git checkout \(branch)
        git pull --ff-only origin \(branch)
        """
        runSetupScript(script, label: "Update repo")
    }

    func setupNode() {
        installLatestNode(label: "Setup Node.js")
    }

    func updateNode() {
        installLatestNode(label: "Update Node.js")
    }

    func startClient() {
        guard !isRunningClient else { return }
        let indexPath = URL(fileURLWithPath: resolvedRepoPath).appendingPathComponent("apps/client/index.js").path
        let keyPath = settings.clientKeyPath.expandedTildePath
        let certPath = settings.clientCertPath.expandedTildePath
        let caPath = settings.caCertPath.expandedTildePath
        guard validateClientPreflight(indexPath: indexPath, keyPath: keyPath, certPath: certPath, caPath: caPath) else { return }

        var args = [indexPath, "--server", settings.server, "--target", settings.target, "--key", keyPath, "--cert", certPath, "--ca", caPath]
        if settings.multipath { args.append("--multipath") }
        if settings.preserveHost { args.append("--preserve-host") }
        settings.domainsText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.forEach {
            args.append(contentsOf: ["--domain", $0])
        }

        logs.append("Starting client: \(resolvedNodePath) \(args.joined(separator: " "))")
        isRunningClient = true
        clientProcess = ShellRunner.run(resolvedNodePath, args, cwd: resolvedRepoPath, log: logs.append) { [weak self] status in
            self?.logs.append("Client exited with status \(status)")
            self?.isRunningClient = false
            self?.clientProcess = nil
        }
    }

    func stopClient() {
        guard let clientProcess else { return }
        logs.append("Stopping client...")
        clientProcess.terminate()
    }

    func showMainWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let window = NSApplication.shared.windows.first {
            window.makeKeyAndOrderFront(nil)
        }
    }

    func quit() {
        if isRunningClient {
            stopClient()
        }
        NSApplication.shared.terminate(nil)
    }

    private func installLatestNode(label: String) {
        guard !isSettingUp else { return }
        isSettingUp = true
        logs.append("\(label): checking official Node.js release index for latest LTS")
        let nodeRoot = localNodeRoot.path.bashQuoted
        let nodePath = resolvedNodePath.bashQuoted
        let script = """
        set -euo pipefail
        TMP="$(mktemp -d)"
        cleanup() { rm -rf "$TMP"; }
        trap cleanup EXIT

        INDEX="$TMP/index.json"
        curl -fsSL https://nodejs.org/dist/index.json -o "$INDEX"
        VERSION="$(/usr/bin/python3 - "$INDEX" <<'PY'
        import json, sys
        with open(sys.argv[1], encoding='utf-8') as f:
            releases = json.load(f)
        for release in releases:
            if release.get('lts'):
                print(release['version'])
                break
        else:
            raise SystemExit('No LTS Node.js release found')
        PY
        )"
        MACHINE="$(uname -m)"
        case "$MACHINE" in
          arm64) ARCH="arm64" ;;
          x86_64) ARCH="x64" ;;
          *) echo "Unsupported macOS architecture: $MACHINE" >&2; exit 1 ;;
        esac
        TARBALL="node-${VERSION}-darwin-${ARCH}.tar.gz"
        URL="https://nodejs.org/dist/${VERSION}/${TARBALL}"
        echo "Installing Node.js ${VERSION} (${ARCH}) from ${URL}"
        curl -fsSL "$URL" -o "$TMP/node.tar.gz"
        tar -xzf "$TMP/node.tar.gz" -C "$TMP"
        EXTRACTED="$TMP/node-${VERSION}-darwin-${ARCH}"
        test -x "$EXTRACTED/bin/node"

        rm -rf \(nodeRoot).tmp
        mkdir -p \(nodeRoot).tmp
        cp -R "$EXTRACTED"/* \(nodeRoot).tmp/
        rm -rf \(nodeRoot)
        mv \(nodeRoot).tmp \(nodeRoot)
        \(nodePath) --version
        """
        runSetupScript(script, label: label)
    }

    private func runSetupScript(_ script: String, label: String) {
        setupProcess = ShellRunner.run("/bin/bash", ["-lc", script], log: logs.append) { [weak self] status in
            self?.logs.append("\(label) exited with status \(status)")
            self?.isSettingUp = false
            self?.refreshInstallStatus()
        }
    }

    private func validateBranch() -> Bool {
        let branch = settings.branchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty else {
            logs.append("Branch name is required.")
            return false
        }
        settings.branchName = branch
        return true
    }

    private func validateClientPreflight(indexPath: String, keyPath: String, certPath: String, caPath: String) -> Bool {
        refreshInstallStatus()
        let fileManager = FileManager.default
        guard fileManager.isExecutableFile(atPath: resolvedNodePath) else {
            logs.append("Node executable is missing or not executable: \(resolvedNodePath)")
            return false
        }
        guard fileManager.fileExists(atPath: indexPath) else {
            logs.append("Client entrypoint not found. Clone/update the repo first: \(indexPath)")
            return false
        }
        for (label, path) in [("client key", keyPath), ("client cert", certPath), ("CA cert", caPath)] {
            guard !path.isEmpty, fileManager.fileExists(atPath: path) else {
                logs.append("Missing required \(label) file: \(path.isEmpty ? "not set" : path)")
                return false
            }
        }
        guard settings.server.contains(":"), settings.target.contains(":") else {
            logs.append("Server and target must use host:port format.")
            return false
        }
        return true
    }

    nonisolated private static func nodeVersionStringAsync(atPath nodePath: String) async -> String {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: nodeVersionString(atPath: nodePath))
            }
        }
    }

    nonisolated private static func nodeVersionString(atPath nodePath: String) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["--version"]
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Installed"
        } catch {
            return "Installed (version unavailable)"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

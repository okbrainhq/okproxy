import AppKit
import Combine
import Darwin
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
    @Published var latestNodeVersion: String?
    @Published var isNodeSetup = false
    @Published var isRepoSetup = false
    /// Set when the last client stop had to be forced, or could not be verified.
    @Published var lastStopNotice: String?

    private let supervisor: ProcessSupervisor
    private let gate = OperationGate()
    private var activeClient: OwnedChildProcess?
    private var activeClientToken: UUID?
    private var nodeVersionToken: UUID?
    private var updateCheckTask: Task<Void, Never>?
    private var shutdownDeadlineTask: Task<Void, Never>?
    private var lastAvailabilitySummary: String?

    /// True while a client shutdown transaction holds the gate.
    var isStoppingClient: Bool { gate.active == .clientStop }

    var isShuttingDown: Bool { gate.isShuttingDown }

    init() {
        AppPaths.ensureStateDirectories()
        // Acquire before touching transactional state regardless of SwiftUI's
        // model/delegate initialization ordering. Failure must not permit recovery.
        switch SingleInstanceGuard.shared.acquire(stateDirectory: AppPaths.stateDirectory) {
        case .acquired: break
        case .alreadyRunning:
            SingleInstanceGuard.activateExistingInstance(bundleIdentifier: Bundle.main.bundleIdentifier)
            exit(EXIT_SUCCESS)
        case .failed(let reason):
            AppPaths.appendLaunchNote("Cannot safely acquire state ownership: \(reason)")
            exit(EXIT_FAILURE)
        }
        supervisor = ProcessSupervisor.shared
        let loaded = AppSettings.loadResult()
        settings = loaded.settings
        logs = LogStore(fileURL: AppPaths.logFileURL)
        if let warning = loaded.warning {
            logs.append(warning)
        }
        refreshInstallStatus()
        logs.append("App launched (\(appEnvironment))")
        // Self-heal first: a helper stranded by a crash, a force quit or an
        // external kill must never keep this launch from stopping its client.
        sweepLeftoversFromPreviousLaunch()
        if settings.startClientAutomatically {
            Task { @MainActor in
                await Task.yield()
                self.startClient()
            }
        }
    }

    // MARK: - Paths

    static var defaultStateDirectory: URL {
        AppPaths.stateDirectory
    }

    var appEnvironment: String { AppPaths.appEnvironment }

    var isDevBuild: Bool { appEnvironment == "dev" }

    var stateDirectoryName: String { AppPaths.stateDirectoryName }

    var stateDirectory: URL { AppPaths.stateDirectory }

    var logFilePath: String { AppPaths.logFileURL.path }

    var resolvedRepoPath: String { AppPaths.repoDirectory.path }

    var resolvedNodePath: String { AppPaths.nodeExecutable.path }

    var localNodeRoot: URL { AppPaths.nodeRoot }

    // MARK: - Install status

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
        AppPaths.ensureStateDirectories()
        guard !supervisor.hasRunningSetup, recoverNodeTransaction() else {
            isNodeSetup = false
            return
        }
        let fileManager = FileManager.default
        let nodePath = resolvedNodePath
        isNodeSetup = fileManager.isExecutableFile(atPath: nodePath)
        isRepoSetup = fileManager.fileExists(atPath: AppPaths.repoDirectory.appendingPathComponent(".git").path)

        nodeVersionToken = nil
        updateCheckTask?.cancel()

        guard isNodeSetup else {
            installedNodeVersion = "Not installed"
            latestNodeVersion = nil
            lastAvailabilitySummary = nil
            return
        }
        guard !gate.isShuttingDown else { return }

        installedNodeVersion = "Checking…"
        let token = UUID()
        nodeVersionToken = token

        // The version probe is a supervised child too: it belongs to our process
        // group, is reaped with waitpid, and is killed by the quit sweep. Output
        // goes to a private temp file (no pipe-pressure path at all).
        let handle = supervisor.spawn(
            executable: nodePath,
            arguments: ["--version"],
            role: .versionProbe,
            output: .capture(maxBytes: 4096)
        ) { [weak self] result in
            guard let self, self.nodeVersionToken == token, !self.gate.isShuttingDown else { return }
            self.nodeVersionToken = nil
            let version = (result.capturedOutput ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if result.exitCode == 0, !version.isEmpty {
                self.installedNodeVersion = version
                self.checkForNodeUpdates(installed: version)
            } else {
                self.installedNodeVersion = "Installed (version unavailable)"
            }
        }

        if handle == nil {
            nodeVersionToken = nil
            installedNodeVersion = "Installed (version probe could not start)"
        }
    }

    /// Must run before any probe/autostart. Mirrors installer recovery; never
    /// executes an uncommitted binary. Rename rollback is restart-idempotent.
    private func recoverNodeTransaction() -> Bool {
        let fm = FileManager.default
        let root = localNodeRoot
        let previous = URL(fileURLWithPath: root.path + ".previous")
        let stage = URL(fileURLWithPath: root.path + ".staging")
        let transaction = URL(fileURLWithPath: root.path + ".transaction")
        do {
            let phase = fm.fileExists(atPath: transaction.path)
                ? try String(contentsOf: transaction, encoding: .utf8) : ""
            guard ["", "existing", "new", "committed"].contains(phase) else {
                logs.append("Unknown Node install transaction; startup blocked.")
                return false
            }
            func removeIfPresent(_ url: URL) throws {
                if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            }
            if phase == "committed" {
                try removeIfPresent(previous)
            } else if fm.fileExists(atPath: previous.path) {
                try removeIfPresent(root)
                try fm.moveItem(at: previous, to: root)
            } else if phase == "new" {
                try removeIfPresent(root)
            }
            try removeIfPresent(stage)
            try removeIfPresent(transaction)
            return true
        } catch {
            logs.append("Node transaction recovery failed; startup blocked: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Repository setup

    func cloneRepo() {
        guard validateBranch(), beginSetupOperation("repository setup") else { return }
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
        guard validateBranch(), beginSetupOperation("repository update") else { return }
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

    // MARK: - Node.js setup

    func setupNode() {
        installLatestNode(label: "Setup Node.js")
    }

    func updateNode() {
        installLatestNode(label: "Update Node.js")
    }

    private func installLatestNode(label: String) {
        guard beginSetupOperation("Node.js setup") else { return }
        logs.append("\(label): checking the official Node.js release index for the latest LTS release")
        let nodeRoot = localNodeRoot.path.bashQuoted
        let nodeBin = resolvedNodePath.bashQuoted
        let statePath = stateDirectory.path.bashQuoted
        let script = """
        set -euo pipefail

        NODE_ROOT=\(nodeRoot)
        NODE_BIN=\(nodeBin)
        STATE_DIR=\(statePath)
        DIST_BASE="${OKPROXY_NODE_DIST_BASE:-https://nodejs.org/dist}"
        DIST_BASE="${DIST_BASE%/}"
        mkdir -p "$STATE_DIR"

        # Fixed staging/backup names so an interrupted run can be recovered on the
        # next start (a SIGKILL leaves no chance to run a trap).
        STAGE="${NODE_ROOT}.staging"
        PREV="${NODE_ROOT}.previous"
        TMP="$(mktemp -d "${TMPDIR:-/tmp}/okproxy-node.XXXXXX")"

        TXN="${NODE_ROOT}.transaction"
        recover() {
          PHASE=""
          if [ -e "$TXN" ]; then PHASE="$(cat "$TXN")" || return 1; fi
          case "$PHASE" in ""|existing|new|committed) ;; *) return 1 ;; esac
          if [ "$PHASE" = committed ]; then
            rm -rf "$PREV"
          elif [ -e "$PREV" ]; then
            rm -rf "$NODE_ROOT"
            mv "$PREV" "$NODE_ROOT"
          elif [ "$PHASE" = new ]; then
            rm -rf "$NODE_ROOT"
          elif [ -n "$PHASE" ] && [ "$PHASE" != existing ]; then
            echo "Unknown Node transaction; refusing to use it" >&2
            return 1
          fi
          rm -rf "$STAGE"
          rm -f "$TXN"
        }
        phase() { printf '%s' "$1" >"${TXN}.tmp"; mv "${TXN}.tmp" "$TXN"; }
        cleanup() {
          rm -rf "$TMP"
          recover
        }
        # Restore even when an unvalidated active directory exists. A committed
        # marker is the ONLY permission to discard the previous valid install.
        recover
        trap cleanup EXIT

        CURL_PROTO=()
        case "$DIST_BASE" in https://*) CURL_PROTO=(--proto '=https' --proto-redir '=https') ;; esac
        fetch() { curl -fsSL --tlsv1.2 --retry 3 --retry-delay 2 ${CURL_PROTO[@]+"${CURL_PROTO[@]}"} "$1" -o "$2"; }

        sha256_of() {
          if [ -x /usr/bin/shasum ]; then
            /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{ print $1 }'
          elif command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$1" | /usr/bin/awk '{ print $1 }'
          else
            echo "No SHA-256 tool available (shasum/sha256sum); refusing to install." >&2
            exit 1
          fi
        }

        copy_tree() {
          if [ -x /usr/bin/ditto ]; then
            /usr/bin/ditto "$1" "$2"
          else
            mkdir -p "$2"
            cp -R "$1"/. "$2"/
          fi
        }

        fetch "$DIST_BASE/index.json" "$TMP/index.json"

        VERSION="$(/usr/bin/python3 - "$TMP/index.json" <<'PY'
        import json, re, sys
        with open(sys.argv[1], encoding='utf-8') as handle:
            releases = json.load(handle)
        best = None
        for release in releases:
            if not release.get('lts'):
                continue
            match = re.fullmatch(r'v([0-9]+)[.]([0-9]+)[.]([0-9]+)', release.get('version', ''))
            if not match:
                continue
            key = tuple(int(part) for part in match.groups())
            if best is None or key > best[0]:
                best = (key, release['version'])
        if best is None:
            raise SystemExit('No stable LTS Node.js release found in the release index')
        print(best[1])
        PY
        )"

        printf '%s' "$VERSION" | grep -Eq '^v[0-9][0-9]*[.][0-9][0-9]*[.][0-9][0-9]*$' \\
          || { echo "Unexpected Node.js version from the release index: $VERSION" >&2; exit 1; }

        MACHINE="$(/usr/bin/uname -m)"
        case "$MACHINE" in
          arm64) ARCH="arm64" ;;
          x86_64) ARCH="x64" ;;
          *) echo "Unsupported macOS architecture: $MACHINE" >&2; exit 1 ;;
        esac

        TARBALL="node-${VERSION}-darwin-${ARCH}.tar.gz"
        BASE="$DIST_BASE/${VERSION}"
        echo "Installing Node.js ${VERSION} (${ARCH})"

        fetch "$BASE/$TARBALL" "$TMP/$TARBALL"
        fetch "$BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt"

        EXPECTED="$(/usr/bin/awk -v f="$TARBALL" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHASUMS256.txt")"
        if [ -z "$EXPECTED" ]; then
          echo "No published SHA-256 checksum for $TARBALL; refusing to install." >&2
          exit 1
        fi
        ACTUAL="$(sha256_of "$TMP/$TARBALL")"
        if [ "$EXPECTED" != "$ACTUAL" ]; then
          echo "Checksum mismatch for $TARBALL (expected $EXPECTED, got $ACTUAL); refusing to install." >&2
          exit 1
        fi
        echo "Verified SHA-256 checksum for $TARBALL"

        /usr/bin/tar -xzf "$TMP/$TARBALL" -C "$TMP"
        EXTRACTED="$TMP/node-${VERSION}-darwin-${ARCH}"
        test -x "$EXTRACTED/bin/node"

        mkdir -p "$STAGE"
        copy_tree "$EXTRACTED" "$STAGE"
        test -x "$STAGE/bin/node"

        # Validate the NEW install from staging, before the working install is
        # touched at all.
        STAGED_VERSION="$("$STAGE/bin/node" --version 2>/dev/null || true)"
        if ! printf '%s' "$STAGED_VERSION" | grep -Eq '^v[0-9][0-9]*[.][0-9]'; then
          echo "Staged Node.js failed validation (got '${STAGED_VERSION}'); keeping the existing install." >&2
          exit 1
        fi
        echo "Staged Node.js validated: $STAGED_VERSION"

        # Transactional swap. The backup survives until the activated copy has
        # itself been validated, so a bad install can never leave the user with
        # no Node.js at all.
        if [ -e "$NODE_ROOT" ]; then
          phase existing
          mv "$NODE_ROOT" "$PREV"
        else
          phase new
        fi
        if ! mv "$STAGE" "$NODE_ROOT"; then
          if [ -e "$PREV" ]; then
            mv "$PREV" "$NODE_ROOT"
          fi
          echo "Failed to activate the new Node.js install; previous version restored." >&2
          exit 1
        fi

        if ! "$NODE_BIN" --version >/dev/null 2>&1; then
          rm -rf "$NODE_ROOT"
          if [ -e "$PREV" ]; then
            mv "$PREV" "$NODE_ROOT"
            echo "Activated Node.js failed validation; previous version restored." >&2
          else
            echo "Activated Node.js failed validation and no previous version was available." >&2
          fi
          exit 1
        fi

        phase committed
        rm -rf "$PREV"
        rm -f "$TXN"
        "$NODE_BIN" --version
        """
        runSetupScript(script, label: label)
    }

    // MARK: - Client lifecycle

    func startClient() {
        guard !isRunningClient, !supervisor.hasRunningClient else { return }
        guard !gate.isShuttingDown else {
            logs.append("The app is shutting down; the client will not be started.")
            return
        }
        guard gate.acquire(.clientStart) else {
            logs.append("Cannot start the client while \(gate.lastRefusalReason ?? "another operation") is in progress.")
            return
        }
        defer { gate.release(.clientStart) }

        guard !isSettingUp, !supervisor.hasRunningSetup else {
            logs.append("A setup operation is still running; wait for it to finish before starting the client.")
            return
        }
        guard let server = Endpoint.parse(settings.server) else {
            logs.append("Server must be host:port (use [ipv6]:port for IPv6 literals): \(settings.server.isEmpty ? "not set" : settings.server)")
            return
        }
        guard let target = Endpoint.parse(settings.target) else {
            logs.append("Target must be host:port (use [ipv6]:port for IPv6 literals): \(settings.target.isEmpty ? "not set" : settings.target)")
            return
        }

        let indexPath = AppPaths.repoDirectory.appendingPathComponent("apps/client/index.js").path
        let keyPath = settings.clientKeyPath.expandedTildePath
        let certPath = settings.clientCertPath.expandedTildePath
        let caPath = settings.caCertPath.expandedTildePath
        guard validateClientPreflight(indexPath: indexPath, keyPath: keyPath, certPath: certPath, caPath: caPath) else { return }

        // Never start a second client on top of a leftover that an earlier stop
        // could not verify. Reclaim first and refuse only when that fails.
        let orphans = supervisor.reclaimOrphanedRuns(reason: "client start preflight")
        if orphans.needsAttention {
            let detail = orphans.unverified.joined(separator: "; ")
            logs.append("Refusing to start the client: leftover supervised processes could not be reclaimed (\(detail)). Use “Clean Up Leftover Processes”, then retry.")
            lastStopNotice = detail
            return
        }
        if orphans.inspectedRecords > 0 {
            logs.append(orphans.summary)
        }

        var args = [indexPath, "--server", server.serialized, "--target", target.serialized, "--key", keyPath, "--cert", certPath, "--ca", caPath]
        if settings.multipath { args.append("--multipath") }
        if settings.preserveHost { args.append("--preserve-host") }
        settings.domainsText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.forEach {
            args.append(contentsOf: ["--domain", $0])
        }

        let token = UUID()
        activeClientToken = token
        logs.append("Starting client: \(resolvedNodePath) \(args.joined(separator: " "))")
        isRunningClient = true

        let handle = supervisor.spawn(
            executable: resolvedNodePath,
            arguments: args,
            cwd: resolvedRepoPath,
            role: .client,
            output: .stream(maxBufferedCharacters: 262_144),
            log: { [weak self] text in self?.logs.append(text) },
            onExit: { [weak self] result in
                guard let self, self.activeClientToken == token else { return }
                self.logs.append("Client exited with \(Self.describe(result))")
                if result.cleanupAttention {
                    self.lastStopNotice = "The client exited without verifiable descendant cleanup; recorded leftovers were swept."
                } else if let reason = result.failureReason {
                    self.lastStopNotice = "Client supervision ended without a confirmed exit: \(reason)"
                }
                self.finishClientExit(token: token)
            }
        )

        guard let handle else {
            isRunningClient = false
            activeClientToken = nil
            logs.append("Client could not be started.")
            return
        }
        activeClient = handle
    }

    /// All confirmed-exit paths release the matching stop lease BEFORE clearing
    /// identity. Stale callbacks cannot release a newer client's gate.
    private func finishClientExit(token: UUID) {
        guard activeClientToken == token else { return }
        gate.release(.clientStop)
        isRunningClient = false
        activeClient = nil
        activeClientToken = nil
    }

    func stopClient() {
        guard let client = activeClient, let token = activeClientToken else { return }
        if client.hasConfirmedExit {
            finishClientExit(token: token)
            return
        }
        // Repeated Stop is a no-op while this same stop is pending.
        guard gate.active != .clientStop else { return }
        guard gate.acquire(.clientStop) else {
            logs.append("Cannot stop the client while \(gate.lastRefusalReason ?? "another operation") is in progress.")
            return
        }

        logs.append("Stopping client…")
        supervisor.stop(client, gracePeriod: 2.0) { [weak self] outcome in
            guard let self, self.activeClientToken == token else { return }
            self.completeStop(outcome, token: token)
        }
    }

    /// Escape hatch that always works, even when the graceful path is wedged.
    /// Available from the menu bar and the Connection tab.
    func forceStopClient() {
        guard let client = activeClient, let token = activeClientToken else {
            // Nothing is owned in memory: still reclaim whatever is recorded on
            // disk, and clear a client transaction that can never complete.
            let report = supervisor.reclaimRecordedRuns(reason: "user requested a force stop")
            logs.append(report.summary)
            if report.needsAttention {
                lastStopNotice = report.unverified.joined(separator: "; ")
            }
            if let stale = gate.active, stale == .clientStop || stale == .clientStart {
                gate.release(stale)
                logs.append("Cleared the unfinished \(stale.label) transaction: no process was owned for it.")
            }
            isRunningClient = false
            activeClient = nil
            activeClientToken = nil
            return
        }
        if gate.active == nil { _ = gate.acquire(.clientStop) }
        logs.append("Force-stopping the client…")
        supervisor.forceStop(client) { [weak self] outcome in
            guard let self, self.activeClientToken == token else { return }
            self.completeStop(outcome, token: token, forced: true)
        }
    }

    /// One terminal path for every stop.
    ///
    /// The operation gate is ALWAYS released here: an app that can never stop its
    /// client (or never quit) is worse than one that stops it and reports that
    /// cleanup had to be forced. The outcome only decides what the user is told.
    private func completeStop(_ outcome: StopOutcome, token: UUID, forced: Bool = false) {
        guard activeClientToken == token else { return }
        switch outcome {
        case .confirmedClean:
            logs.append("Client stopped.")
            lastStopNotice = nil
        case .cleanupIncomplete(let reason), .forcedUnconfirmed(let reason):
            logs.append("Client \(forced ? "force-stopped" : "stopped") with attention: \(reason)")
            lastStopNotice = reason
        }
        finishClientExit(token: token)
    }

    func showMainWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let window = NSApplication.shared.windows.first {
            window.makeKeyAndOrderFront(nil)
        }
    }

    func quit() {
        guard !gate.isShuttingDown else { return }
        // Central exclusion until exit: no new setup/start transaction can begin.
        gate.shutdown()
        logs.append("Quitting: stopping all owned child processes…")

        // Hard deadline: a child that refuses to die must never be able to keep
        // the app running. `applicationWillTerminate` repeats the synchronous
        // sweep when AppKit gets there first.
        shutdownDeadlineTask?.cancel()
        shutdownDeadlineTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.shutdownDeadlineTask = nil
            self.logs.append("Shutdown deadline reached; forcing termination with a hard sweep.")
            let report = ProcessSupervisor.shared.terminateAllNow(gracePeriod: 1.0)
            if report.needsAttention { self.lastStopNotice = report.summary }
            NSApplication.shared.terminate(nil)
        }

        // `stopAll` is bounded at every rung, so this completion always arrives.
        supervisor.stopAll(gracePeriod: 2.0) { [weak self] report in
            guard let self else { return }
            self.shutdownDeadlineTask?.cancel()
            self.shutdownDeadlineTask = nil
            if report.needsAttention {
                self.lastStopNotice = report.summary
                self.logs.append("Shutdown: \(report.summary)")
            }
            NSApplication.shared.terminate(nil)
        }
    }

    /// Reclaims supervised processes stranded by an earlier launch (crash, force
    /// quit, external kill). Runs once at startup, before any autostart.
    private func sweepLeftoversFromPreviousLaunch() {
        let report = supervisor.sweepStaleRunRecords()
        guard report.inspectedRecords > 0 else { return }
        logs.append(report.summary)
        if report.needsAttention {
            let detail = report.unverified.joined(separator: "; ")
            lastStopNotice = detail
            logs.append("Some leftover supervised processes could not be reclaimed: \(detail)")
        }
    }

    /// User-facing escape hatch for leftovers recorded by earlier or forced runs.
    func reclaimLeftoverProcesses() {
        let report = supervisor.reclaimRecordedRuns(reason: "user requested a leftover cleanup")
        logs.append(report.summary)
        lastStopNotice = report.needsAttention ? report.unverified.joined(separator: "; ") : nil
        refreshInstallStatus()
    }

    // MARK: - Setup plumbing

    private static func describe(_ result: ChildExit) -> String {
        if let reason = result.failureReason { return "failure: \(reason)" }
        if let signal = result.signal { return "signal \(signal)" }
        return "status \(result.exitCode)"
    }

    private func beginSetupOperation(_ description: String) -> Bool {
        guard !gate.isShuttingDown else {
            logs.append("The app is shutting down; \(description) will not be started.")
            return false
        }
        guard !isRunningClient, !supervisor.hasRunningClient else {
            logs.append("Stop the client before running \(description).")
            return false
        }
        guard !isStoppingClient else {
            logs.append("The client is still shutting down; retry \(description) once it has stopped.")
            return false
        }
        guard gate.acquire(.setup) else {
            logs.append("Cannot start \(description) while \(gate.lastRefusalReason ?? "another operation") is in progress.")
            return false
        }
        isSettingUp = true
        return true
    }

    private func runSetupScript(_ script: String, label: String) {
        let spawned = supervisor.spawn(
            executable: "/bin/bash",
            arguments: ["-c", script],
            cwd: stateDirectory.path,
            role: .setup,
            environment: ["GIT_TERMINAL_PROMPT": "0"],
            output: .stream(maxBufferedCharacters: 262_144),
            log: { [weak self] text in self?.logs.append(text) },
            onExit: { [weak self] result in
                guard let self else { return }
                self.logs.append("\(label) exited with \(Self.describe(result))")
                self.isSettingUp = false
                self.gate.release(.setup)
                self.refreshInstallStatus()
            }
        )

        if spawned == nil {
            isSettingUp = false
            gate.release(.setup)
            logs.append("\(label) was not started because another setup operation is still running.")
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
        guard isNodeSetup, fileManager.isExecutableFile(atPath: resolvedNodePath) else {
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
        return true
    }

    // MARK: - Update checks (full semantic version, not major-only)

    private func checkForNodeUpdates(installed: String) {
        updateCheckTask?.cancel()
        guard !gate.isShuttingDown, let installedVersion = SemanticVersion(installed) else { return }

        updateCheckTask = Task { [weak self] in
            do {
                let data = try await NodeReleaseCatalog.fetchIndexData()
                guard !Task.isCancelled, let self, !self.gate.isShuttingDown else { return }
                guard let latest = try NodeReleaseCatalog.latestLTS(from: data) else { return }
                let kind = SemanticVersion.updateKind(installed: installedVersion, latest: latest)
                self.publishUpdateAvailability(kind: kind, installed: installedVersion, latest: latest)
            } catch {
                // Offline or blocked: keep showing the locally installed version.
            }
        }
    }

    private func publishUpdateAvailability(kind: UpdateKind, installed: SemanticVersion, latest: SemanticVersion) {
        latestNodeVersion = latest.description
        let summary = "Node.js \(installed) — \(kind.summary) (latest LTS \(latest))"
        guard summary != lastAvailabilitySummary else { return }
        lastAvailabilitySummary = summary
        logs.append(summary)
    }
}

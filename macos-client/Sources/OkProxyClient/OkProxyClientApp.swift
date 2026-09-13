import AppKit
import Darwin
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Directories first: the lock file, log store, run records and node
        // install all expect their parents to exist.
        AppPaths.ensureStateDirectories()

        switch SingleInstanceGuard.shared.acquire(stateDirectory: AppPaths.stateDirectory) {
        case .acquired:
            break
        case .alreadyRunning:
            // A second copy of this build would share UserDefaults, the log file
            // and the client child process. Activate the existing copy and exit
            // before AppModel (and any shared state) is created.
            AppPaths.appendLaunchNote("Another OkProxy Client instance is already running; activating it instead of starting a duplicate.")
            SingleInstanceGuard.activateExistingInstance(bundleIdentifier: Bundle.main.bundleIdentifier)
            exit(EXIT_SUCCESS)
        case .failed(let reason):
            AppPaths.appendLaunchNote("Single-instance guard unavailable (\(reason)); refusing shared state access.")
            exit(EXIT_FAILURE)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private var terminationPending = false

    /// Termination is deferred ONLY to give children a graceful window. A hard
    /// deadline replies anyway, so a child that refuses to die can never make the
    /// app un-quittable - the failure mode this used to have.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ProcessSupervisor.shared.runningProcessCount > 0 else { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true

        Task { @MainActor in
            let replied = CompletionFlag()
            let deadline = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled, !replied.isSet else { return }
                replied.isSet = true
                self.terminationPending = false
                AppPaths.appendLaunchNote("Shutdown deadline reached; terminating after a hard sweep.")
                let report = ProcessSupervisor.shared.terminateAllNow(gracePeriod: 1.0)
                if report.needsAttention {
                    AppPaths.appendLaunchNote("Hard sweep: \(report.summary)")
                }
                sender.reply(toApplicationShouldTerminate: true)
            }
            ProcessSupervisor.shared.stopAll(gracePeriod: 2.0) { report in
                guard !replied.isSet else { return }
                replied.isSet = true
                deadline.cancel()
                self.terminationPending = false
                if report.needsAttention {
                    AppPaths.appendLaunchNote("Shutdown: \(report.summary)")
                }
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Final synchronous sweep: SIGTERM, brief grace, helper force signal, then
        // a reclaim for anything still standing. Nothing is matched by name, so
        // unrelated processes are never signalled.
        ProcessSupervisor.shared.terminateAllNow(gracePeriod: 1.0)
        SingleInstanceGuard.shared.release()
    }
}

/// Shared one-shot flag so the deferred reply and its deadline cannot both fire.
@MainActor
final class CompletionFlag {
    var isSet = false
}

@main
struct OkProxyClientApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.openWindow) private var openWindow
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("OkProxy Client", id: "main") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 900, minHeight: 760)
        }
        .windowStyle(.titleBar)

        MenuBarExtra {
            Text(model.isDevBuild ? "OkProxy Client Dev" : "OkProxy Client")
                .font(.headline)
            Text(model.isRunningClient ? "Client running" : "Client stopped")
            Divider()
            Button("Show Window") {
                openWindow(id: "main")
                DispatchQueue.main.async {
                    model.showMainWindow()
                }
            }
            Divider()
            Button(model.isRunningClient ? "Stop Client" : "Start Client") {
                if model.isRunningClient {
                    model.stopClient()
                } else {
                    model.startClient()
                }
            }
            if model.isRunningClient {
                Button("Force Stop Client (always works)") {
                    model.forceStopClient()
                }
            }
            Button("Clean Up Leftover Processes") {
                model.reclaimLeftoverProcesses()
            }
            Toggle("Start Client Automatically", isOn: $model.settings.startClientAutomatically)
            Divider()
            Button("Quit") { model.quit() }
        } label: {
            Label("OkProxy", systemImage: model.isDevBuild ? "network.badge.shield.half.filled" : "network")
                .symbolRenderingMode(model.isDevBuild ? .multicolor : .hierarchical)
        }
        .menuBarExtraStyle(.menu)
    }
}

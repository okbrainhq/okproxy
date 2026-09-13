import AppKit
import Darwin
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Directories first: the lock file, log store and node install all
        // expect their parents to exist.
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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ProcessSupervisor.shared.runningProcessCount > 0 else { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        // Defer start so even a synchronous empty completion cannot precede
        // returning terminateLater to AppKit.
        Task { @MainActor in
            ProcessSupervisor.shared.stopAll { [weak self] stopped in
                self?.terminationPending = false
                if !stopped {
                    AppPaths.appendLaunchNote("Shutdown incomplete; refusing termination and retaining process ownership.")
                }
                sender.reply(toApplicationShouldTerminate: stopped)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Final synchronous sweep: SIGTERM, brief grace, then SIGKILL for the
        // processes this app spawned. Nothing is matched by name, so unrelated
        // processes are never signalled.
        ProcessSupervisor.shared.terminateAllNow()
        SingleInstanceGuard.shared.release()
    }
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
            Button(model.isRunningClient ? "Stop Client" : "Start Client") {
                if model.isRunningClient {
                    model.stopClient()
                } else {
                    model.startClient()
                }
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

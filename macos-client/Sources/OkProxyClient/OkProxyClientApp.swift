import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
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

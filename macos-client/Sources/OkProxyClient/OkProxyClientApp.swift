import SwiftUI

@main
struct OkProxyClientApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 900, minHeight: 640)
        }
        .windowStyle(.titleBar)
    }
}

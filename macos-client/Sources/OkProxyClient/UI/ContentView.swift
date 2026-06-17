import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedTab: Tab = .setup

    private enum Tab: Hashable {
        case setup
        case connection
        case logs
    }

    var body: some View {
        VStack(spacing: 10) {
            TabView(selection: $selectedTab) {
                SetupView()
                    .tabItem { Label("Setup", systemImage: "gearshape") }
                    .tag(Tab.setup)
                ConnectionView()
                    .tabItem { Label("Connection", systemImage: "network") }
                    .tag(Tab.connection)
                LogsView(logs: model.logs, logFilePath: model.logFilePath, isActive: selectedTab == .logs)
                    .tabItem { Label("Logs", systemImage: "doc.text") }
                    .tag(Tab.logs)
            }

            if selectedTab != .logs {
                Divider()
                CompactLogsView(logs: model.logs)
                    .frame(height: 150)
            }
        }
        .padding()
    }
}

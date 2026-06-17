import SwiftUI

struct ContentView: View {
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
                LogsView()
                    .tabItem { Label("Logs", systemImage: "doc.text") }
                    .tag(Tab.logs)
            }

            if selectedTab != .logs {
                Divider()
                CompactLogsView()
                    .frame(height: 150)
            }
        }
        .padding()
    }
}

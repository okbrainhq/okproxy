import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            SetupView()
                .tabItem { Label("Setup", systemImage: "gearshape") }
            ConnectionView()
                .tabItem { Label("Connection", systemImage: "network") }
            LogsView()
                .tabItem { Label("Logs", systemImage: "doc.text") }
        }
        .padding()
    }
}

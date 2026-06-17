import SwiftUI

struct LogsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Logs")
                    .font(.headline)
                Text(model.logFilePath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Clear Logs") { model.logs.clear() }
            }
            LogScrollView(minHeight: 260, font: .body)
        }
    }
}

struct LogScrollView: View {
    @EnvironmentObject private var model: AppModel
    let minHeight: CGFloat
    let font: Font.TextStyle

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(model.logs.text.isEmpty ? "Logs will appear here." : model.logs.text)
                    .font(.system(font, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .id("logs-end")
            }
            .onChange(of: model.logs.text) { _ in
                proxy.scrollTo("logs-end", anchor: .bottom)
            }
            .frame(minHeight: minHeight)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
        }
    }
}

struct CompactLogsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Live Logs", systemImage: "terminal")
                    .font(.caption.bold())
                Spacer()
                Button("Clear") { model.logs.clear() }
                    .font(.caption)
            }
            LogScrollView(minHeight: 110, font: .caption)
        }
    }
}

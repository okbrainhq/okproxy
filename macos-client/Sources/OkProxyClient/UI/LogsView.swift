import SwiftUI

struct LogsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Button("Clear Logs") { model.logs.clear() }
                Spacer()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    Text(model.logs.text.isEmpty ? "Logs will appear here." : model.logs.text)
                        .font(.system(.body, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .id("logs-end")
                }
                .onChange(of: model.logs.text) { _ in
                    proxy.scrollTo("logs-end", anchor: .bottom)
                }
            }
        }
    }
}

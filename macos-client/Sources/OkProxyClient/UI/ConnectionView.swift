import SwiftUI

struct ConnectionView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Section("Host Details") {
                TextField("Server host:port", text: $model.settings.server)
                TextField("Target host:port", text: $model.settings.target)
            }

            Section("Required mTLS Files") {
                pathRow("Client key (--key)", value: $model.settings.clientKeyPath)
                pathRow("Client cert (--cert)", value: $model.settings.clientCertPath)
                pathRow("CA cert (--ca)", value: $model.settings.caCertPath)
            }

            Section("Options") {
                Toggle("Enable multipath", isOn: $model.settings.multipath)
                Toggle("Preserve Host header", isOn: $model.settings.preserveHost)
                TextEditor(text: $model.settings.domainsText)
                    .frame(minHeight: 70)
                    .overlay(alignment: .topLeading) {
                        if model.settings.domainsText.isEmpty {
                            Text("Optional domains, one per line")
                                .foregroundStyle(.secondary)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                        }
                    }
            }

            Section("Client") {
                HStack {
                    Button(model.isRunningClient ? "Running…" : "Start Client") { model.startClient() }
                        .disabled(model.isRunningClient)
                    Button("Stop Client") { model.stopClient() }
                        .disabled(!model.isRunningClient)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func pathRow(_ title: String, value: Binding<String>) -> some View {
        HStack {
            TextField(title, text: value)
            Button("Choose…") { model.chooseFile { value.wrappedValue = $0 } }
        }
    }
}

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
                Text("Choose… shows hidden files and dot-directories so keys under folders like .certs can be selected.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                pathRow("Client key (--key)", value: $model.settings.clientKeyPath)
                pathRow("Client cert (--cert)", value: $model.settings.clientCertPath)
                pathRow("CA cert (--ca)", value: $model.settings.caCertPath)
            }

            Section("Options") {
                Toggle("Enable multipath", isOn: $model.settings.multipath)
                Toggle("Preserve Host header", isOn: $model.settings.preserveHost)
                Toggle("Start Client Automatically", isOn: $model.settings.startClientAutomatically)
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
                    Button("Force Stop") { model.forceStopClient() }
                        .help("Reclaim the client and any leftover supervised processes immediately, even when the supervisor is wedged. Always available.")
                }
                if let notice = model.lastStopNotice {
                    Label(notice, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Button("Clean Up Leftover Processes") { model.reclaimLeftoverProcesses() }
                    .font(.caption)
                    .help("Kill supervised processes recorded by an earlier run that was crashed, force quit or killed.")
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

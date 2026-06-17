import SwiftUI

struct SetupView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Section("Environment") {
                LabeledContent("State directory", value: model.stateDirectory.path)
                statusRow(title: "Repository", isOK: model.isRepoSetup, detail: model.resolvedRepoPath)
                statusRow(title: "Node.js", isOK: model.isNodeSetup, detail: "\(model.resolvedNodePath) — \(model.installedNodeVersion)")
                LabeledContent("Logs", value: model.logFilePath)
            }

            Section("Local Node.js") {
                Text("Node.js is installed from the official latest LTS release index.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Button(model.isSettingUp ? "Working…" : "Setup Node.js") { model.setupNode() }
                        .disabled(model.isSettingUp)
                    Button(model.isSettingUp ? "Working…" : "Update Node.js") { model.updateNode() }
                        .disabled(model.isSettingUp)
                    Button("Refresh") { model.refreshInstallStatus() }
                }
            }

            Section("Repository") {
                LabeledContent("Remote", value: AppSettings.repoURL)
                TextField("Branch", text: $model.settings.branchName)
                HStack {
                    Button(model.isSettingUp ? "Working…" : "Clone Repo") { model.cloneRepo() }
                        .disabled(model.isSettingUp)
                    Button(model.isSettingUp ? "Working…" : "Update Repo") { model.updateRepo() }
                        .disabled(model.isSettingUp)
                }
                Text("Clone/update checks out the selected branch physically in the local repo.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshInstallStatus() }
    }

    private func statusRow(title: String, isOK: Bool, detail: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: isOK ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(isOK ? .green : .orange)
                .accessibilityLabel(isOK ? "OK" : "Warning")
            LabeledContent(title, value: detail)
        }
    }
}

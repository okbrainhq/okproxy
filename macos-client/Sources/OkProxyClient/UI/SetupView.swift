import SwiftUI

struct SetupView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Section("Environment") {
                LabeledContent("State directory", value: model.stateDirectory.path)
                LabeledContent("Repository", value: model.resolvedRepoPath)
                LabeledContent("Node.js", value: model.resolvedNodePath)
                Text("Dev builds use ~/.okproxy-dev. Production builds use ~/.okproxy.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
    }
}

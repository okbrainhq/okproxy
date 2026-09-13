import Foundation

/// Transaction kinds that must not overlap.
enum OperationKind: String {
    case setup
    case clientStart
    case clientStop

    var label: String {
        switch self {
        case .setup: return "a setup operation"
        case .clientStart: return "client start"
        case .clientStop: return "client shutdown"
        }
    }
}

/// Central exclusion gate for mutating operations (audit: "beginSetup ignores
/// isStoppingClient and start/setup ignore isQuitting").
///
/// One long-lived owner per transaction: setup holds the gate for its whole
/// lifetime, client start/stop hold it only for their transaction window. Once
/// `shutdown()` is called (quit), every later `acquire` fails, so no new child
/// can be spawned while the app is tearing down.
///
/// All access happens on the main actor (`AppModel`), so no locking is needed.
final class OperationGate {
    private(set) var active: OperationKind?
    private(set) var isShuttingDown = false
    private(set) var lastRefusalReason: String?

    func acquire(_ kind: OperationKind) -> Bool {
        if isShuttingDown {
            lastRefusalReason = "the app is shutting down"
            return false
        }
        if let active, active != kind {
            lastRefusalReason = "\(active.label) is still in progress"
            return false
        }
        active = kind
        lastRefusalReason = nil
        return true
    }

    func release(_ kind: OperationKind) {
        if active == kind {
            active = nil
        }
    }

    /// Permanently block new transactions (application is quitting).
    func shutdown() {
        isShuttingDown = true
    }
}

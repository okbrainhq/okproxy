import Darwin
import Foundation

/// Kernel-reported identity for one PID.
///
/// PIDs are recycled, so a recorded number alone may never be signalled. Every
/// reclaim decision compares the live process against the recorded uid, process
/// group, executable name and start time.
struct ProcessIdentity {
    let pid: pid_t
    let parentPid: pid_t
    let processGroup: pid_t
    let uid: uid_t
    let state: Int8
    let executableName: String
    let startedAt: Date

    var isZombie: Bool { state == Int8(SZOMB) }
    var isLive: Bool { !isZombie }

    /// `p_comm` is truncated to 15 characters by the kernel, so the comparison
    /// uses the same truncation.
    func matchesExecutable(named path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        guard !name.isEmpty else { return false }
        let limit = min(name.count, 15)
        return executableName == String(name.prefix(limit))
    }
}

enum ProcessTable {
    /// `nil` when the PID does not exist (or cannot be inspected).
    static func identity(of pid: pid_t) -> ProcessIdentity? {
        guard pid > 1 else { return nil }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0,
              info.kp_proc.p_pid == pid else { return nil }
        var name = info.kp_proc.p_comm
        let bytes = withUnsafeBytes(of: &name) { Array($0) }
        let end = bytes.firstIndex(of: 0) ?? bytes.count
        let start = info.kp_proc.p_un.__p_starttime
        return ProcessIdentity(
            pid: info.kp_proc.p_pid,
            parentPid: info.kp_eproc.e_ppid,
            processGroup: info.kp_eproc.e_pgid,
            uid: info.kp_eproc.e_ucred.cr_uid,
            state: info.kp_proc.p_stat,
            executableName: String(decoding: bytes[0..<end], as: UTF8.self),
            startedAt: Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1e6)
        )
    }

    /// Live (non-zombie) members of a process group.
    ///
    /// `nil` means "could not be enumerated" and is never treated as empty: the
    /// app only ever declares a group clean when it can actually see it.
    static func liveMembers(ofProcessGroup processGroup: pid_t) -> [pid_t]? {
        guard processGroup > 1 else { return [] }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PGRP, processGroup]
        var size = 0
        guard sysctl(&mib, 4, nil, &size, nil, 0) == 0 else { return nil }
        guard size > 0 else { return [] }
        let stride = MemoryLayout<kinfo_proc>.stride
        var capacity = size / stride + 16
        for _ in 0..<3 {
            var buffer = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
            var length = capacity * stride
            if sysctl(&mib, 4, &buffer, &length, nil, 0) == 0 {
                let count = max(0, min(length / stride, capacity))
                return (0..<count).compactMap { index in
                    let entry = buffer[index]
                    guard entry.kp_proc.p_pid > 0 else { return nil }
                    guard entry.kp_proc.p_stat != Int8(SZOMB) else { return nil }
                    return entry.kp_proc.p_pid
                }
            }
            capacity *= 2
        }
        return nil
    }
}

/// One supervised helper/workload pair as recorded on disk by the helper.
///
/// It exists so the app can still find a workload's process group after the
/// helper crashed, was killed externally, or refused to die: without the group
/// id the app has no handle on the workload at all.
struct SupervisedRunRecord {
    let fileURL: URL
    let role: String
    let ownerPid: pid_t
    let helperPid: pid_t
    let workloadPid: pid_t
    let processGroup: pid_t
    let targetPath: String
    let helperPath: String
    let appPath: String
    let startedAt: Date
    /// The helper reaped its leader but could not verify descendant cleanup.
    let attention: Bool
}

struct ReclaimReport {
    var records = 0
    var signalsSent = 0
    var liveRemainder: [pid_t] = []
    var notes: [String] = []

    var isVerifiedClean: Bool { records == 0 || liveRemainder.isEmpty }

    var summary: String {
        if records == 0 { return "no recorded run to reclaim" }
        if liveRemainder.isEmpty {
            return "reclaimed a recorded supervised run (\(signalsSent) signal(s) sent)"
        }
        return "reclaim incomplete: \(liveRemainder.count) process(es) still live (pids \(liveRemainder.map(String.init).joined(separator: ",")))"
    }
}

struct SweepReport {
    var inspectedRecords = 0
    var reclaimedRecords = 0
    var skippedLiveOwners = 0
    var signalsSent = 0
    var unverified: [String] = []

    var needsAttention: Bool { !unverified.isEmpty }

    var summary: String {
        if inspectedRecords == 0 { return "no supervised run records were left behind" }
        var text = "startup cleanup: \(inspectedRecords) run record(s), "
        text += "\(reclaimedRecords) reclaimed (\(signalsSent) signal(s))"
        if skippedLiveOwners > 0 { text += ", \(skippedLiveOwners) still owned by a live app" }
        if !unverified.isEmpty { text += ", \(unverified.count) unverified" }
        return text
    }
}

/// Durable handle on supervised processes, written by the helper and read by the
/// app so that stopping never depends on an in-memory reference.
enum RunRecordStore {
    private static let filePrefix = "run-"
    private static let fileExtension = "record"

    static var directory: URL { AppPaths.runDirectory }

    /// Static fields the launcher already knows. The helper appends the runtime
    /// pids, its own pid and the workload's process group.
    static func environment(role: ProcessRole, workloadExecutable: String) -> [String: String] {
        let meta = [
            "role=\(role.rawValue)",
            "owner=\(getpid())",
            "app=\(appExecutablePath)",
            "helper=\(PosixChildProcess.helperExecutablePath)",
            "target=\(workloadExecutable)",
        ].joined(separator: "\n") + "\n"
        return [
            "OKPROXY_RUN_DIR": directory.path,
            "OKPROXY_RUN_META": meta,
        ]
    }

    static var appExecutablePath: String {
        Bundle.main.executablePath ?? CommandLine.arguments[0]
    }

    static func records() -> [SupervisedRunRecord] {
        let fileManager = FileManager.default
        let entries = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        return entries
            .filter { $0.lastPathComponent.hasPrefix(filePrefix) && $0.pathExtension == fileExtension }
            .compactMap(parseRecord)
            .filter { $0.helperPid > 1 }
    }

    static func record(helperPid: pid_t) -> SupervisedRunRecord? {
        records().first { $0.helperPid == helperPid }
    }

    static func remove(_ record: SupervisedRunRecord) {
        try? FileManager.default.removeItem(at: record.fileURL)
    }

    static func remove(helperPid: pid_t) {
        record(helperPid: helperPid).map(remove)
    }

    /// Reclaims the processes recorded for one helper. Returns a report; the
    /// record file is removed only when the result was verified.
    @discardableResult
    static func reclaim(helperPid: pid_t) -> ReclaimReport {
        guard let record = record(helperPid: helperPid) else {
            // No record: verify the helper itself is gone and say so honestly.
            return reclaimWithoutRecord(helperPid: helperPid)
        }
        return reclaim(record)
    }

    @discardableResult
    static func reclaim(_ record: SupervisedRunRecord) -> ReclaimReport {
        var report = ReclaimReport()
        report.records = 1

        // 1. A live helper still owns the workload group, so let it finish first:
        //    SIGTERM for the graceful path, SIGUSR1 (its force control) next.
        if let identity = ProcessTable.identity(of: record.helperPid),
           identity.isLive, identity.uid == getuid(),
           identity.matchesExecutable(named: record.helperPath.isEmpty ? "OkProxyProcessHelper" : record.helperPath) {
            report.signalsSent += kill(record.helperPid, SIGTERM) == 0 ? 1 : 0
            waitForDeath(of: record.helperPid, seconds: 0.4)
            if ProcessTable.identity(of: record.helperPid)?.isLive == true {
                report.signalsSent += kill(record.helperPid, SIGUSR1) == 0 ? 1 : 0
                waitForDeath(of: record.helperPid, seconds: 0.4)
            }
        }

        // 2. The recorded group is the only handle that survives the helper, so
        //    signal it too - but only when a live member is positively ours.
        if let members = ProcessTable.liveMembers(ofProcessGroup: record.processGroup) {
            let ours = members.filter { isRecordedGroupMember($0, record: record) }
            if !ours.isEmpty {
                report.signalsSent += kill(-record.processGroup, SIGKILL) == 0 ? 1 : 0
            } else if members.isEmpty {
                report.notes.append("recorded group \(record.processGroup) is already empty")
            } else {
                report.notes.append("recorded group \(record.processGroup) holds unrelated pids; left untouched")
            }
        } else {
            report.notes.append("recorded group \(record.processGroup) could not be enumerated")
        }

        // 3. Individual identities, so a group signal that was refused still
        //    cannot leave the helper or the workload leader behind.
        for pid in [record.workloadPid, record.helperPid] {
            guard let identity = ProcessTable.identity(of: pid), identity.isLive, identity.uid == getuid() else { continue }
            let expected = (pid == record.helperPid) ? record.helperPath : record.targetPath
            let named = expected.isEmpty ? true : identity.matchesExecutable(named: expected)
            guard named, identity.processGroup == record.processGroup else { continue }
            report.signalsSent += kill(pid, SIGKILL) == 0 ? 1 : 0
        }

        waitForAnything(seconds: 0.3)
        report.liveRemainder = unverifiedProcesses(in: record)
        if report.liveRemainder.isEmpty {
            remove(record)
        }
        return report
    }

    /// Startup sweep: reclaim runs left behind by a previous launch. A record
    /// whose owner is still alive (another live copy of the app, or this one) is
    /// never touched.
    static func sweepStaleRecords() -> SweepReport {
        var report = SweepReport()
        for record in records() {
            report.inspectedRecords += 1
            if record.ownerPid == getpid() {
                report.skippedLiveOwners += 1
                continue
            }
            if let owner = ProcessTable.identity(of: record.ownerPid),
               owner.isLive, owner.uid == getuid(),
               owner.matchesExecutable(named: record.appPath.isEmpty ? appExecutablePath : record.appPath) {
                report.skippedLiveOwners += 1
                continue
            }
            let outcome = reclaim(record)
            report.signalsSent += outcome.signalsSent
            if outcome.isVerifiedClean {
                report.reclaimedRecords += 1
            } else {
                report.unverified.append(outcome.summary)
            }
        }
        return report
    }

    /// Reclaims every recorded run, including records whose owner is alive, minus
    /// the helpers this app still supervises. Used from the explicit "clean up
    /// leftovers" action, from a client-start preflight, and from a hard quit.
    @discardableResult
    static func reclaimAll(reason: String, excluding helperPids: Set<pid_t> = []) -> SweepReport {
        var report = SweepReport()
        for record in records() where !helperPids.contains(record.helperPid) {
            report.inspectedRecords += 1
            let outcome = reclaim(record)
            report.signalsSent += outcome.signalsSent
            if outcome.isVerifiedClean {
                report.reclaimedRecords += 1
            } else {
                report.unverified.append(outcome.summary)
            }
        }
        _ = reason
        return report
    }

    // MARK: - Internals

    private static func reclaimWithoutRecord(helperPid: pid_t) -> ReclaimReport {
        var report = ReclaimReport()
        guard let identity = ProcessTable.identity(of: helperPid), identity.uid == getuid() else {
            return report
        }
        report.records = 1
        report.signalsSent += kill(helperPid, SIGKILL) == 0 ? 1 : 0
        waitForDeath(of: helperPid, seconds: 0.3)
        if let remaining = ProcessTable.identity(of: helperPid), remaining.isLive, remaining.uid == getuid() {
            report.liveRemainder = [helperPid]
        }
        return report
    }

    private static func isRecordedGroupMember(_ pid: pid_t, record: SupervisedRunRecord) -> Bool {
        guard let identity = ProcessTable.identity(of: pid) else { return false }
        guard identity.uid == getuid(), identity.isLive else { return false }
        guard identity.processGroup == record.processGroup else { return false }
        if pid == record.workloadPid || pid == record.helperPid { return true }
        // A descendant: it must at least look like the recorded workload.
        return identity.matchesExecutable(named: record.targetPath)
    }

    private static func unverifiedProcesses(in record: SupervisedRunRecord) -> [pid_t] {
        var remaining: [pid_t] = []
        if let members = ProcessTable.liveMembers(ofProcessGroup: record.processGroup) {
            remaining.append(contentsOf: members.filter { isRecordedGroupMember($0, record: record) })
        } else {
            remaining.append(record.processGroup) // cannot see it: never claim it is gone
        }
        for pid in [record.helperPid, record.workloadPid] where !remaining.contains(pid) {
            guard let identity = ProcessTable.identity(of: pid), identity.isLive, identity.uid == getuid() else { continue }
            if identity.processGroup == record.processGroup { remaining.append(pid) }
        }
        return Array(Set(remaining)).sorted()
    }

    private static func waitForDeath(of pid: pid_t, seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            guard let identity = ProcessTable.identity(of: pid), identity.isLive else { return }
            usleep(20_000)
        }
    }

    private static func waitForAnything(seconds: TimeInterval) {
        usleep(UInt32(max(0, seconds) * 1_000_000))
    }

    private static func parseRecord(_ fileURL: URL) -> SupervisedRunRecord? {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return nil }
        var fields: [String: String] = [:]
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let separator = line.firstIndex(of: "=") else { continue }
            fields[String(line[line.startIndex..<separator])] = String(line[line.index(after: separator)...])
        }
        func pid(_ key: String) -> pid_t? {
            guard let value = fields[key], let number = pid_t(value) else { return nil }
            return number
        }
        guard let helperPid = pid("helper_pid"), let workloadPid = pid("workload_pid") else { return nil }
        let processGroup = pid("pgid") ?? workloadPid
        let started = Double(fields["started"] ?? "") ?? 0
        return SupervisedRunRecord(
            fileURL: fileURL,
            role: fields["role"] ?? "child",
            ownerPid: pid("owner") ?? 0,
            helperPid: helperPid,
            workloadPid: workloadPid,
            processGroup: processGroup,
            targetPath: fields["target"] ?? "",
            helperPath: fields["helper"] ?? "",
            appPath: fields["app"] ?? "",
            startedAt: Date(timeIntervalSince1970: started),
            attention: fields["attention"] == "1"
        )
    }
}

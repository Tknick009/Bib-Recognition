#if canImport(UIKit)
import Foundation
import Combine

/// Runs `work` on the main thread, in order with everything else sent this way.
func onMain(_ work: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async {
        MainActor.assumeIsolated(work)
    }
}

/// Keeps the race clock synchronized with NTP time servers.
///
/// The best fix so far is saved, so it survives the app being closed (though
/// not the iPad being restarted) and a race can be timed where there is no
/// network, as long as the iPad was synchronized earlier.
@MainActor
final class TimeService: ObservableObject {
    /// What one server said during the last synchronization.
    struct ServerReport: Identifiable, Equatable {
        var server: String
        var sample: NTPSample?
        var error: String?

        var id: String { server }
    }

    enum Level {
        case good
        case fair
        case poor
        case unsynced
    }

    @Published private(set) var fix: ClockFix?
    @Published private(set) var isSyncing = false
    @Published private(set) var lastError: String?
    /// Monotonic time of the last synchronization in which a server answered.
    @Published private(set) var lastContact: Double?
    @Published private(set) var reports: [ServerReport] = []

    let clock: RaceClock
    private var servers: [String]
    private var loop: Task<Void, Never>?

    private static let storageKey = "BibTimer.clockFix.v1"

    init(clock: RaceClock, servers: [String]) {
        self.clock = clock
        self.servers = servers
        if let data = UserDefaults.standard.data(forKey: TimeService.storageKey),
           let saved = try? JSONDecoder().decode(ClockFix.self, from: data),
           saved.isUsable(nowMono: clock.monoNow(), nowWall: clock.wallNow()) {
            fix = saved
            clock.setFix(saved)
        }
    }

    func setServers(_ newServers: [String]) {
        servers = newServers
    }

    /// Synchronizes now and keeps doing so: every few minutes once there is a
    /// fix, more often while there is none.
    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let pause = await self?.syncAndPlanNext() else { return }
                try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
            }
        }
    }

    private func syncAndPlanNext() async -> Double {
        await sync()
        if fix == nil { return 15 }
        return lastError == nil ? 300 : 45
    }

    /// Asks every configured server for the time and adopts the best answer.
    func sync() async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }

        let monotonic = clock.monotonic
        let entries = servers
        let answers = await withTaskGroup(of: (String, Result<[NTPSample], Error>).self) { group -> [(String, Result<[NTPSample], Error>)] in
            for entry in entries {
                let target = AppSettings.hostAndPort(entry)
                group.addTask {
                    let result = await NTPClient.samples(host: target.host, port: target.port, clock: monotonic)
                    return (entry, result)
                }
            }
            var collected: [(String, Result<[NTPSample], Error>)] = []
            for await answer in group {
                collected.append(answer)
            }
            return collected
        }

        var best: [NTPSample] = []
        var newReports: [ServerReport] = []
        for (entry, result) in answers {
            switch result {
            case .success(let samples):
                let sample = NTPSelection.best(of: samples)
                if let sample { best.append(sample) }
                newReports.append(ServerReport(server: entry, sample: sample, error: nil))
            case .failure(let error):
                newReports.append(ServerReport(server: entry, sample: nil, error: TimeService.describe(error)))
            }
        }
        reports = newReports.sorted { $0.server < $1.server }

        guard let choice = NTPSelection.select(best) else {
            lastError = entries.isEmpty
                ? "No time servers are set."
                : "No time server answered. Check the internet connection."
            return
        }

        let nowMono = clock.monoNow()
        let sample = choice.sample
        let candidate = ClockFix(
            utcMinusMono: sample.utcMinusMono,
            uncertainty: sample.errorBound,
            monoTime: sample.takenAt,
            wallTime: clock.wallNow() - (nowMono - sample.takenAt),
            server: sample.server,
            stratum: sample.stratum,
            delay: sample.delay,
            agreeing: choice.agreeing,
            responding: choice.responding
        )
        lastError = nil
        lastContact = nowMono

        // A fix is only replaced by a better one; see ClockFix.shouldBeReplaced.
        if let current = fix, !current.shouldBeReplaced(by: candidate, nowMono: nowMono) {
            return
        }
        fix = candidate
        clock.setFix(candidate)
        if let data = try? JSONEncoder().encode(candidate) {
            UserDefaults.standard.set(data, forKey: TimeService.storageKey)
        }
    }

    // MARK: Status

    /// The race clock's current error bound in seconds; nil without a fix.
    var currentUncertainty: Double? {
        guard let fix else { return nil }
        return fix.uncertainty(atMono: clock.monoNow())
    }

    /// Seconds since the fix in use was taken.
    var fixAge: Double? {
        guard let fix else { return nil }
        return clock.monoNow() - fix.monoTime
    }

    var level: Level {
        guard let uncertainty = currentUncertainty else { return .unsynced }
        if uncertainty <= 0.1 { return .good }
        if uncertainty <= 0.5 { return .fair }
        return .poor
    }

    /// A short description such as "NTP ±12 ms".
    var summary: String {
        guard let uncertainty = currentUncertainty else { return "Not synced" }
        return "NTP " + TimeService.formatError(uncertainty)
    }

    nonisolated static func formatError(_ seconds: Double) -> String {
        if seconds < 0.9995 {
            return "±\(max(Int((seconds * 1000).rounded()), 1)) ms"
        }
        return "±" + String(format: "%.1f", seconds) + " s"
    }

    nonisolated static func formatAge(_ seconds: Double) -> String {
        let whole = Int(max(seconds, 0))
        if whole < 60 { return "\(whole) s ago" }
        if whole < 3600 { return "\(whole / 60) min ago" }
        return "\(whole / 3600) h \(whole % 3600 / 60) min ago"
    }

    private nonisolated static func describe(_ error: Error) -> String {
        if let known = error as? NTPError, let text = known.errorDescription {
            return text
        }
        return error.localizedDescription
    }
}
#endif

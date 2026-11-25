#if canImport(UIKit)
import Combine
import Foundation

/// Keeps the results hub up to date with the open race.
///
/// Results are always saved on the iPad first; this only copies them to the
/// hub. Once a second it looks at what has changed since the last upload the
/// hub accepted and sends that. If an upload fails it waits and tries again,
/// for as long as it takes, so a lost connection delays the copy on the hub
/// but never loses or changes a result.
@MainActor
final class HubSync: ObservableObject {
    enum Status: Equatable {
        /// No results server has been set up.
        case off
        /// A server is set up, but no race is open.
        case idle
        /// This race is being kept off the server.
        case paused
        /// This many results are not on the server yet.
        case waiting(Int)
        case upToDate
        /// The last upload failed; another attempt will follow.
        case failed(String)
    }

    /// The settings uploading depends on.
    struct Config: Equatable {
        var address = ""
        var key = ""
        var station = ""

        init() {}

        init(_ settings: AppSettings) {
            address = settings.hubAddress
            key = settings.hubKey
            station = settings.station
        }

        /// Where to send results, if a server has been set up completely.
        var server: (base: URL, key: String)? {
            let trimmed = HubPlanner.normalizedKey(key)
            guard !trimmed.isEmpty, let base = HubPlanner.baseURL(from: address) else { return nil }
            return (base, trimmed)
        }
    }

    @Published private(set) var status = Status.off
    /// The event code the open race is sent under, when it is being sent.
    @Published private(set) var eventCode: String?
    /// Roughly how many bytes the uploads have used since the app was opened.
    @Published private(set) var dataUsed = 0

    /// Where one race's results go.
    private struct Target: Equatable {
        var raceID: UUID
        var code: String
        var base: URL
        var key: String
    }

    /// How often to check in when there is nothing new, so the scoring
    /// computer can see that this iPad is still connected.
    ///
    /// Hosting services close a connection that has been idle for a while,
    /// commonly after 60 seconds. Checking in a little more often than that
    /// keeps the one connection open, which costs far less data than
    /// connecting afresh each time.
    private static let heartbeat = 45.0
    /// What an upload costs besides its contents: the request and reply
    /// headers and the encryption around them. Measured at a little under
    /// 800 bytes; connections that compress headers use less.
    private static let overheadPerUpload = 800

    private let deviceID: String
    private let monotonic = SystemMonotonicClock()
    private var config = Config()
    private var race: Race?
    /// What the hub holds for `knownTarget`; nil when that is uncertain.
    private var known: HubKnownState?
    private var knownTarget: Target?
    private var failures = 0
    private var lastError: String?
    private var retryAfter = 0.0
    private var lastAttempt = -Double.infinity
    private var loop: Task<Void, Never>?

    init() {
        let storageKey = "BibTimer.deviceID.v1"
        if let saved = UserDefaults.standard.string(forKey: storageKey), saved.count >= 8 {
            deviceID = saved
        } else {
            deviceID = UUID().uuidString
            UserDefaults.standard.set(deviceID, forKey: storageKey)
        }
    }

    /// Follows the settings.
    func update(config newConfig: Config) {
        guard newConfig != config else { return }
        config = newConfig
        refreshStatus()
    }

    /// Follows the open race.
    func update(race newRace: Race?) {
        race = newRace
        refreshStatus()
    }

    /// Tries again without waiting any longer, for when the operator has
    /// just seen the server answer.
    func retryNow() {
        retryAfter = 0
    }

    /// Starts uploading in the background; keeps going for the life of the app.
    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.step()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private var target: Target? {
        guard let race, race.hubPaused != true, let server = config.server else { return nil }
        return Target(raceID: race.id, code: race.eventCode(timeZone: .current), base: server.base, key: server.key)
    }

    private func plan(for race: Race) -> HubPush {
        HubPlanner.push(for: race, station: config.station, timeZone: TimeZone.current.identifier, known: known)
    }

    /// Sends what is due, if anything.
    private func step() async {
        guard let target, let race else { return }
        if knownTarget != target {
            // A different race or server: nothing is known about what it holds.
            knownTarget = target
            known = nil
            failures = 0
            lastError = nil
            retryAfter = 0
            lastAttempt = -Double.infinity
        }

        let now = monotonic.now()
        guard now >= retryAfter else { return }
        let push = plan(for: race)
        guard HubPlanner.hasChanges(push, known: known) || now - lastAttempt >= HubSync.heartbeat else { return }
        lastAttempt = now

        let outcome: Result<HubReply, Error>
        // False when nothing got through, so that next to nothing was used.
        var reachedServer = true
        do {
            outcome = .success(try await HubClient(base: target.base, key: target.key).send(push, code: target.code, device: deviceID))
        } catch {
            if let failure = error as? HubClient.Failure, case .unreachable = failure {
                reachedServer = false
            }
            outcome = .failure(error)
        }
        if reachedServer {
            dataUsed += push.encodedSize + HubSync.overheadPerUpload
        }
        // The race or the settings may have changed while the upload was
        // under way; if so this answer no longer says anything useful.
        guard self.target == target else { return }

        switch outcome {
        case .success(let reply):
            known = HubPlanner.state(after: push, reply: reply, known: known)
            if known == nil, push.full {
                // Everything was sent and the hub still disagrees. Trying
                // again soon would only repeat that.
                noteFailure("The results server did not take in every result.", turnedDown: true)
            } else {
                failures = 0
                lastError = nil
                retryAfter = 0
            }
        case .failure(let error):
            // The server answered and said no (a wrong key, say), as opposed
            // to not being reachable or being out of order for the moment.
            var turnedDown = false
            if let failure = error as? HubClient.Failure, case .refused(let status, _) = failure {
                turnedDown = (400..<500).contains(status) && status != 408 && status != 429
            }
            noteFailure((error as? LocalizedError)?.errorDescription ?? error.localizedDescription, turnedDown: turnedDown)
        }
        refreshStatus()
    }

    /// - Parameter turnedDown: The server received the upload and would not
    ///   have it, which trying again will not change by itself.
    private func noteFailure(_ message: String, turnedDown: Bool = false) {
        failures += 1
        // A single failed attempt to get through is not reported: a
        // connection that has sat idle is sometimes closed just as it is used
        // again, and the next attempt, two seconds later, succeeds.
        lastError = failures >= 2 || turnedDown ? message : nil
        let doublings = pow(2, Double(min(failures, 6)))
        // 2, 4, 8 … seconds between attempts, up to a minute. An upload that
        // was turned down went out in full only to get the same answer, so
        // those are spaced further apart to save data: half a minute, then
        // 1, 2 and 4 minutes, and from then on 5. Changing the settings
        // starts afresh at once.
        let wait = turnedDown ? min(300, 15 * doublings) : min(60, doublings)
        retryAfter = monotonic.now() + wait
    }

    private func refreshStatus() {
        let newStatus: Status
        var newCode: String?
        if config.server == nil {
            newStatus = .off
        } else if let race {
            if race.hubPaused == true {
                newStatus = .paused
            } else {
                newCode = race.eventCode(timeZone: .current)
                if let lastError, knownTarget == target {
                    newStatus = .failed(lastError)
                } else if let known, knownTarget == target {
                    let push = plan(for: race)
                    let pending = push.crossings.count + push.deleted.count
                    newStatus = pending == 0 && !HubPlanner.hasChanges(push, known: known) ? .upToDate : .waiting(pending)
                } else {
                    newStatus = .waiting(race.crossings.count)
                }
            }
        } else {
            newStatus = .idle
        }
        if status != newStatus { status = newStatus }
        if eventCode != newCode { eventCode = newCode }
    }

    /// "850 KB" or "1.3 MB".
    nonisolated static func formatData(_ bytes: Int) -> String {
        if bytes < 1_000_000 {
            return "\(max(bytes, 0) / 1000) KB"
        }
        return String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }
}
#endif

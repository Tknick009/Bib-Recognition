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

    @Published private(set) var status = Status.off
    /// The event code the open race is sent under, when it is being sent.
    @Published private(set) var eventCode: String?

    /// Where one race's results go.
    private struct Target: Equatable {
        var raceID: UUID
        var code: String
        var base: URL
        var key: String
    }

    /// How often to check in when there is nothing new, so the scoring
    /// computer can see that this iPad is still connected.
    private static let heartbeat = 30.0

    private let deviceID: String
    private let monotonic = SystemMonotonicClock()
    private var settings = AppSettings()
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

    /// Follows the open race and the settings.
    func update(race: Race?, settings: AppSettings) {
        self.race = race
        self.settings = settings
        refreshStatus()
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
        guard let race, race.hubPaused != true, let hub = settings.hub else { return nil }
        return Target(raceID: race.id, code: race.eventCode(timeZone: .current), base: hub.base, key: hub.key)
    }

    private func plan(for race: Race) -> HubPush {
        HubPlanner.push(for: race, station: settings.station, timeZone: TimeZone.current.identifier, known: known)
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
        do {
            outcome = .success(try await HubClient(base: target.base, key: target.key).send(push, code: target.code, device: deviceID))
        } catch {
            outcome = .failure(error)
        }
        // The race or the settings may have changed while the upload was
        // under way; if so this answer no longer says anything useful.
        guard self.target == target else { return }

        switch outcome {
        case .success(let reply):
            known = HubPlanner.state(after: push, reply: reply, known: known)
            if known == nil, push.full {
                // Everything was sent and the hub still disagrees. Trying
                // again at once would only repeat that, so back off.
                noteFailure("The results server did not take in every result.")
            } else {
                failures = 0
                lastError = nil
                retryAfter = 0
            }
        case .failure(let error):
            noteFailure((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
        refreshStatus()
    }

    private func noteFailure(_ message: String) {
        failures += 1
        lastError = message
        // 2, 4, 8 … seconds between attempts, up to a minute.
        retryAfter = monotonic.now() + min(60, pow(2, Double(min(failures, 6))))
    }

    private func refreshStatus() {
        let newStatus: Status
        var newCode: String?
        if settings.hub == nil {
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
}
#endif

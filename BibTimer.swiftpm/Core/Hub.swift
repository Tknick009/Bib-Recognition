import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Sending results to a hub: the optional web service (the `hub` folder of the
// repository) that collects results from every iPad at an event, so that the
// scoring computer can read them from one address.
//
// The iPad stays the master copy. It tells the hub what changed since the last
// upload it knows succeeded, and falls back to sending everything whenever it
// cannot be sure what the hub holds.

/// One result as it is sent to the hub.
struct HubCrossing: Codable, Equatable {
    var id: String
    var bib: String
    /// Seconds since 1970 (UTC).
    var time: Double
    var timing: String
    var source: String
    var clock: String
    /// Worst-case clock error in seconds, when known.
    var clockError: Double?
    var confidence: Double?
    var note: String

    init(_ crossing: Crossing) {
        id = crossing.id.uuidString
        bib = crossing.bib
        time = crossing.time.timeIntervalSince1970
        timing = crossing.timing.rawValue
        source = crossing.source.rawValue
        clock = crossing.clock.source.rawValue
        clockError = crossing.clock.uncertainty
        confidence = crossing.confidence
        note = crossing.note
    }
}

/// What one iPad sends to the hub about one race.
struct HubPush: Codable, Equatable {
    var station: String
    var raceName: String
    /// The iPad's time zone, so the hub can show times of day the same way.
    var timeZone: String
    var startTime: Double?
    /// True when `crossings` is the complete list, replacing whatever the hub
    /// held from this iPad; false when it only carries changes.
    var full: Bool
    var crossings: [HubCrossing]
    /// Identifiers of results that have been deleted since the last upload.
    var deleted: [String]

    /// True if the upload changes nothing on the hub except "last heard from".
    var isHeartbeat: Bool {
        !full && crossings.isEmpty && deleted.isEmpty
    }
}

/// The hub's answer to an upload.
struct HubReply: Codable, Equatable {
    /// Identifies the hub's data. A different value means the hub has lost
    /// what it held and needs everything again.
    var store: String
    /// How many results the hub now holds from this iPad for this event.
    var count: Int
}

/// The hub's answer to a connection check.
struct HubPing: Codable, Equatable {
    var ok: Bool
    /// "full" for the access key, "view" for a view-only key.
    var access: String
    /// False if the hub keeps results in memory only.
    var persistent: Bool?
}

/// What the hub is believed to hold from this iPad for one race.
struct HubKnownState: Equatable {
    var store: String
    var crossings: [String: HubCrossing]
    var station: String
    var raceName: String
    var timeZone: String
    var startTime: Double?
}

enum HubPlanner {
    /// The upload that brings the hub up to date with `race`.
    ///
    /// Without knowledge of what the hub holds, everything is sent.
    static func push(for race: Race, station: String, timeZone: String, known: HubKnownState?) -> HubPush {
        let current = race.crossings.map { HubCrossing($0) }
        var push = HubPush(
            station: station,
            raceName: race.name,
            timeZone: timeZone,
            startTime: race.startTime?.timeIntervalSince1970,
            full: true,
            crossings: current,
            deleted: []
        )
        guard let known else { return push }

        let currentIDs = Set(current.map(\.id))
        push.full = false
        push.crossings = current.filter { known.crossings[$0.id] != $0 }
        push.deleted = known.crossings.keys.filter { !currentIDs.contains($0) }.sorted()
        return push
    }

    /// Whether `push` would change anything the hub shows.
    static func hasChanges(_ push: HubPush, known: HubKnownState?) -> Bool {
        guard let known else { return true }
        return !push.isHeartbeat
            || push.station != known.station
            || push.raceName != known.raceName
            || push.timeZone != known.timeZone
            || push.startTime != known.startTime
    }

    /// What the hub holds once it has accepted `push`, or nil if its answer
    /// shows that it holds something else, in which case everything has to be
    /// sent again.
    static func state(after push: HubPush, reply: HubReply, known: HubKnownState?) -> HubKnownState? {
        var crossings: [String: HubCrossing] = [:]
        if !push.full {
            // A partial upload only makes sense on top of the data it was
            // worked out against.
            guard let known, known.store == reply.store else { return nil }
            crossings = known.crossings
        }
        for crossing in push.crossings {
            crossings[crossing.id] = crossing
        }
        for id in push.deleted {
            crossings[id] = nil
        }
        guard reply.count == crossings.count else { return nil }
        return HubKnownState(
            store: reply.store,
            crossings: crossings,
            station: push.station,
            raceName: push.raceName,
            timeZone: push.timeZone,
            startTime: push.startTime
        )
    }

    // MARK: Event codes

    /// The code under which an event's results are collected. Every iPad at
    /// the event must use the same one.
    ///
    /// Built from the race name and date, so iPads on which the race was
    /// created with the same name on the same day agree without any typing.
    static func eventCode(name: String, date: Date, timeZone: TimeZone) -> String {
        let day = TimeFormat.localDate(date, timeZone: timeZone).replacingOccurrences(of: "-", with: "")
        let words = slug(name)
        let base = words.isEmpty ? "race" : String(words.prefix(40)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return base + "-" + day
    }

    /// Tidies up a code that was typed in: lower case, hyphens between words.
    static func normalizedCode(_ text: String) -> String {
        String(slug(text).prefix(50)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    /// 3 to 50 lower-case letters, digits and hyphens, not starting or ending
    /// with a hyphen. The hub applies the same rule.
    static func isValidCode(_ code: String) -> Bool {
        guard (3...50).contains(code.count), code.first != "-", code.last != "-" else { return false }
        return code.allSatisfy { codeCharacters.contains($0) }
    }

    private static let codeCharacters = Set("abcdefghijklmnopqrstuvwxyz0123456789-")

    private static func slug(_ text: String) -> String {
        var result = ""
        for character in text.lowercased() {
            if codeCharacters.contains(character), character != "-" {
                result.append(character)
            } else if !result.isEmpty, result.last != "-" {
                result.append("-")
            }
        }
        return result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    // MARK: Addresses

    /// The hub's address as typed by the operator, as a URL.
    ///
    /// A bare host name gets `https://`. Plain `http://` is only accepted for
    /// this device itself, which is what tests use; anything else must be
    /// encrypted, since the access key travels with every request.
    static func baseURL(from text: String) -> URL? {
        var address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, !address.contains(" ") else { return nil }
        if !address.contains("://") {
            address = "https://" + address
        }
        while address.hasSuffix("/") {
            address.removeLast()
        }
        guard let components = URLComponents(string: address),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.query == nil, components.fragment == nil else { return nil }
        let isLocal = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && isLocal) else { return nil }
        return components.url
    }
}

/// Talks to a hub over HTTPS.
struct HubClient {
    enum Failure: Error, Equatable {
        /// The hub could not be reached at all.
        case unreachable(String)
        /// The hub answered, but refused. Carries its status and explanation.
        case refused(Int, String)
        /// Something answered, but not in the way a hub does.
        case unexpectedReply
    }

    var base: URL
    var key: String
    var session: URLSession = .shared
    var timeout: TimeInterval = 15

    /// Checks that the address leads to a hub and that the key is accepted.
    func ping() async throws -> HubPing {
        let data = try await perform(request(path: ["api", "ping"], method: "GET", body: nil))
        guard let ping = try? JSONDecoder().decode(HubPing.self, from: data) else { throw Failure.unexpectedReply }
        return ping
    }

    /// Uploads one iPad's results for one event.
    func send(_ push: HubPush, code: String, device: String) async throws -> HubReply {
        let body = try JSONEncoder().encode(push)
        let data = try await perform(request(path: ["api", "events", code, "sources", device], method: "PUT", body: body))
        guard let reply = try? JSONDecoder().decode(HubReply.self, from: data) else { throw Failure.unexpectedReply }
        return reply
    }

    func request(path: [String], method: String, body: Data?) -> URLRequest {
        var url = base
        for component in path {
            url.appendPathComponent(component)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let session = self.session
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: Failure.unreachable(error.localizedDescription))
                    return
                }
                guard let http = response as? HTTPURLResponse, let data else {
                    continuation.resume(throwing: Failure.unexpectedReply)
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    continuation.resume(throwing: Failure.refused(http.statusCode, HubClient.explanation(in: data)))
                    return
                }
                continuation.resume(returning: data)
            }
            task.resume()
        }
    }

    /// The hub explains refusals as `{"error": "..."}`.
    private static func explanation(in data: Data) -> String {
        struct Refusal: Decodable {
            var error: String
        }
        return (try? JSONDecoder().decode(Refusal.self, from: data))?.error ?? ""
    }
}

extension HubClient.Failure: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .unreachable(let reason):
            return reason.isEmpty ? "The results server could not be reached." : reason
        case .refused(401, _):
            return "The results server did not accept the access key."
        case .refused(let status, let message):
            return message.isEmpty ? "The results server answered with error \(status)." : message
        case .unexpectedReply:
            return "That address did not answer like a Bib Timer results server."
        }
    }
}

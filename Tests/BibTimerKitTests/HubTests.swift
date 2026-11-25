import XCTest
@testable import BibTimerKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class HubTests: XCTestCase {
    private let base = 1_800_000_000.0
    private let utc = TimeZone(secondsFromGMT: 0)!

    private func crossing(_ bib: String, at seconds: Double) -> Crossing {
        Crossing.manual(bib: bib, time: Date(timeIntervalSince1970: base + seconds),
                        clock: ClockStamp(source: .ntp, uncertainty: 0.012, mono: nil, bootRef: nil))
    }

    private func race(_ crossings: [Crossing]) -> Race {
        var race = Race(name: "Spring 5K")
        race.crossings = crossings
        race.startTime = Date(timeIntervalSince1970: base)
        return race
    }

    private func plan(_ race: Race, known: HubKnownState?) -> HubPush {
        HubPlanner.push(for: race, station: "Finish", timeZone: "UTC", known: known)
    }

    /// The state the hub would be in after accepting `push`, as the app works it out.
    private func accept(_ push: HubPush, known: HubKnownState?, store: String = "store-1", count: Int? = nil) -> HubKnownState? {
        var expected = push.full ? 0 : (known?.crossings.count ?? 0)
        if !push.full {
            let knownIDs = Set(known?.crossings.keys.map { $0 } ?? [])
            expected += push.crossings.filter { !knownIDs.contains($0.id) }.count
            expected -= push.deleted.filter { knownIDs.contains($0) }.count
        } else {
            expected = push.crossings.count
        }
        return HubPlanner.state(after: push, reply: HubReply(store: store, count: count ?? expected), known: known)
    }

    // MARK: Planning

    func testEverythingIsSentWhenNothingIsKnownAboutTheHub() {
        let first = crossing("7", at: 10)
        let push = plan(race([first, crossing("12", at: 20)]), known: nil)
        XCTAssertTrue(push.full)
        XCTAssertEqual(push.crossings.map(\.bib), ["7", "12"])
        XCTAssertEqual(push.deleted, [])
        XCTAssertEqual(push.station, "Finish")
        XCTAssertEqual(push.raceName, "Spring 5K")
        XCTAssertEqual(push.startTime, base)
        XCTAssertFalse(push.isHeartbeat)

        let sent = push.crossings[0]
        XCTAssertEqual(sent.id, first.id.uuidString)
        XCTAssertEqual(sent.time, base + 10, accuracy: 1e-6)
        XCTAssertEqual(sent.timing, "manual")
        XCTAssertEqual(sent.source, "manual")
        XCTAssertEqual(sent.clock, "ntp")
        XCTAssertEqual(sent.clockError, 0.012)
    }

    func testOnlyChangesAreSentAfterASuccessfulUpload() throws {
        let a = crossing("1", at: 10)
        let b = crossing("2", at: 20)
        let c = crossing("3", at: 30)
        var current = race([a, b, c])
        let known = try XCTUnwrap(accept(plan(current, known: nil), known: nil))
        XCTAssertEqual(known.crossings.count, 3)

        // Nothing has changed: nothing to send but a sign of life.
        let idle = plan(current, known: known)
        XCTAssertTrue(idle.isHeartbeat)
        XCTAssertFalse(HubPlanner.hasChanges(idle, known: known))

        // One result corrected, one deleted, one added.
        current.crossings[0].bib = "11"
        current.crossings.remove(at: 1)
        let d = crossing("4", at: 40)
        current.crossings.append(d)
        let changes = plan(current, known: known)
        XCTAssertFalse(changes.full)
        XCTAssertEqual(changes.crossings.map(\.bib), ["11", "4"])
        XCTAssertEqual(changes.deleted, [b.id.uuidString])
        XCTAssertTrue(HubPlanner.hasChanges(changes, known: known))

        let after = try XCTUnwrap(accept(changes, known: known))
        XCTAssertEqual(Set(after.crossings.values.map(\.bib)), ["11", "3", "4"])
        XCTAssertTrue(plan(current, known: after).isHeartbeat)
    }

    func testAChangedStartTimeOrStationNameIsAChange() throws {
        var current = race([crossing("1", at: 10)])
        let known = try XCTUnwrap(accept(plan(current, known: nil), known: nil))

        current.startTime = Date(timeIntervalSince1970: base + 5)
        let moved = plan(current, known: known)
        XCTAssertTrue(moved.isHeartbeat)
        XCTAssertTrue(HubPlanner.hasChanges(moved, known: known))

        let renamed = HubPlanner.push(for: race([crossing("1", at: 10)]), station: "Finish B", timeZone: "UTC", known: known)
        XCTAssertTrue(HubPlanner.hasChanges(renamed, known: known))
    }

    func testAnUnexpectedAnswerMeansEverythingIsSentAgain() throws {
        let current = race([crossing("1", at: 10), crossing("2", at: 20)])
        let full = plan(current, known: nil)
        // The hub holds a different number of results than it should.
        XCTAssertNil(accept(full, known: nil, count: 1))

        let known = try XCTUnwrap(accept(full, known: nil))
        var more = current
        more.crossings.append(crossing("3", at: 30))
        let partial = plan(more, known: known)
        XCTAssertFalse(partial.full)
        // The hub has lost its data since: it answers as a different store.
        XCTAssertNil(accept(partial, known: known, store: "store-2", count: 3))
        // A partial upload cannot be judged without knowing what it was based on.
        XCTAssertNil(accept(partial, known: nil, count: 3))
        // A full upload to the new store is fine.
        XCTAssertEqual(accept(plan(more, known: nil), known: nil, store: "store-2")?.store, "store-2")
    }

    func testUploadsAreWrittenTheWayTheHubReadsThem() throws {
        var current = race([crossing("7", at: 10.5)])
        current.crossings[0].note = "by the barrier"
        let text = String(decoding: try JSONEncoder().encode(plan(current, known: nil)), as: UTF8.self)
        // The names the hub looks for.
        for key in ["station", "raceName", "timeZone", "startTime", "full", "crossings", "deleted",
                    "id", "bib", "time", "timing", "source", "clock", "clockError", "note"] {
            XCTAssertTrue(text.contains("\"\(key)\":"), "\(key) is missing from \(text)")
        }
        XCTAssertTrue(text.contains("\"full\":true"), text)
        XCTAssertTrue(text.contains("\"note\":\"by the barrier\""), text)
        // Unknown values are left out rather than sent as null.
        XCTAssertFalse(text.contains("confidence"), text)
        XCTAssertFalse(text.contains("null"), text)

        var unstarted = current
        unstarted.startTime = nil
        let withoutStart = String(decoding: try JSONEncoder().encode(plan(unstarted, known: nil)), as: UTF8.self)
        XCTAssertFalse(withoutStart.contains("startTime"), withoutStart)

        // And it reads back as what was sent.
        let push = plan(current, known: nil)
        XCTAssertEqual(try JSONDecoder().decode(HubPush.self, from: JSONEncoder().encode(push)), push)
    }

    // MARK: Event codes

    func testEventCodeFromNameAndDate() {
        let newYear = Date(timeIntervalSince1970: 1_609_459_200)
        XCTAssertEqual(HubPlanner.eventCode(name: "Spring 5K / Fun Run", date: newYear, timeZone: utc), "spring-5k-fun-run-20210101")
        XCTAssertEqual(HubPlanner.eventCode(name: "  ", date: newYear, timeZone: utc), "race-20210101")
        XCTAssertEqual(HubPlanner.eventCode(name: "Été à Paris", date: newYear, timeZone: utc), "t-paris-20210101")
        // The date is the local one.
        XCTAssertEqual(HubPlanner.eventCode(name: "Dash", date: newYear, timeZone: TimeZone(secondsFromGMT: -5 * 3600)!), "dash-20201231")

        let long = HubPlanner.eventCode(name: String(repeating: "marathon ", count: 20), date: newYear, timeZone: utc)
        XCTAssertLessThanOrEqual(long.count, 50)
        XCTAssertTrue(HubPlanner.isValidCode(long), long)
    }

    func testEventCodeRules() {
        XCTAssertTrue(HubPlanner.isValidCode("spring-5k-20261125"))
        XCTAssertTrue(HubPlanner.isValidCode("abc"))
        XCTAssertFalse(HubPlanner.isValidCode("ab"))
        XCTAssertFalse(HubPlanner.isValidCode("Spring"))
        XCTAssertFalse(HubPlanner.isValidCode("-spring"))
        XCTAssertFalse(HubPlanner.isValidCode("spring-"))
        XCTAssertFalse(HubPlanner.isValidCode("spring 5k"))
        XCTAssertFalse(HubPlanner.isValidCode(String(repeating: "a", count: 51)))

        XCTAssertEqual(HubPlanner.normalizedCode("  Spring 5K — Finish  "), "spring-5k-finish")
        XCTAssertEqual(HubPlanner.normalizedCode("spring-5k-20261125"), "spring-5k-20261125")
        XCTAssertEqual(HubPlanner.normalizedCode("!!!"), "")
    }

    // MARK: Addresses

    func testServerAddresses() {
        XCTAssertEqual(HubPlanner.baseURL(from: "bibs.up.railway.app")?.absoluteString, "https://bibs.up.railway.app")
        XCTAssertEqual(HubPlanner.baseURL(from: " https://bibs.up.railway.app/ ")?.absoluteString, "https://bibs.up.railway.app")
        XCTAssertEqual(HubPlanner.baseURL(from: "https://example.org/hub")?.absoluteString, "https://example.org/hub")
        XCTAssertEqual(HubPlanner.baseURL(from: "http://127.0.0.1:8765")?.absoluteString, "http://127.0.0.1:8765")
        XCTAssertEqual(HubPlanner.baseURL(from: "http://localhost:8765/")?.absoluteString, "http://localhost:8765")
        // The access key must not travel unencrypted.
        XCTAssertNil(HubPlanner.baseURL(from: "http://bibs.up.railway.app"))
        XCTAssertNil(HubPlanner.baseURL(from: ""))
        XCTAssertNil(HubPlanner.baseURL(from: "not an address"))
        XCTAssertNil(HubPlanner.baseURL(from: "ftp://example.org"))
        XCTAssertNil(HubPlanner.baseURL(from: "https://example.org/?key=abc"))
    }

    func testRequestsCarryTheKeyAndAddressTheRightPlace() throws {
        let client = HubClient(base: try XCTUnwrap(HubPlanner.baseURL(from: "https://example.org/hub")), key: "secret-key")
        let request = client.request(path: ["api", "events", "spring-5k", "sources", "DEVICE-1"], method: "PUT", body: Data("{}".utf8))
        XCTAssertEqual(request.url?.absoluteString, "https://example.org/hub/api/events/spring-5k/sources/DEVICE-1")
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-key")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testFailuresAreExplained() {
        XCTAssertEqual(HubClient.Failure.refused(401, "whatever").errorDescription, "The results server did not accept the access key.")
        XCTAssertEqual(HubClient.Failure.refused(409, "Too many results from one iPad.").errorDescription, "Too many results from one iPad.")
        XCTAssertEqual(HubClient.Failure.refused(500, "").errorDescription, "The results server answered with error 500.")
        XCTAssertEqual(HubClient.Failure.unreachable("The Internet connection appears to be offline.").errorDescription, "The Internet connection appears to be offline.")
    }
}

/// Runs the real client against a real hub. Only where one has been started
/// for the purpose (CI does that): `BIBTIMER_HUB_URL` and `BIBTIMER_HUB_KEY`.
final class HubIntegrationTests: XCTestCase {
    private func client(key: String? = nil) throws -> HubClient {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["BIBTIMER_HUB_URL"], let realKey = environment["BIBTIMER_HUB_KEY"],
              let base = HubPlanner.baseURL(from: address) else {
            throw XCTSkip("no hub to test against (set BIBTIMER_HUB_URL and BIBTIMER_HUB_KEY)")
        }
        return HubClient(base: base, key: key ?? realKey, timeout: 10)
    }

    private func csv(_ client: HubClient, code: String, query: String = "") async throws -> String {
        var request = client.request(path: ["api", "events", code, "results.csv"], method: "GET", body: nil)
        if !query.isEmpty, let url = request.url {
            request.url = URL(string: url.absoluteString + "?" + query)
        }
        let finished = request
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.dataTask(with: finished) { data, _, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? HubClient.Failure.unexpectedReply)
                }
            }.resume()
        }
        return String(decoding: data, as: UTF8.self)
    }

    func testTheHubAcceptsTheKeyAndRefusesAWrongOne() async throws {
        let ping = try await client().ping()
        XCTAssertTrue(ping.ok)
        XCTAssertEqual(ping.access, "full")

        do {
            _ = try await client(key: "definitely-not-the-key").ping()
            XCTFail("a wrong key was accepted")
        } catch let failure as HubClient.Failure {
            guard case .refused(401, _) = failure else {
                return XCTFail("expected a refusal, got \(failure)")
            }
        }
    }

    func testResultsReachTheHubAndStayInStep() async throws {
        let client = try client()
        let code = "swift-test-" + UUID().uuidString.lowercased().prefix(8)
        let device = UUID().uuidString
        let start = 1_609_459_200.0

        var race = Race(name: "Integration Dash")
        race.startTime = Date(timeIntervalSince1970: start)
        let clock = ClockStamp(source: .ntp, uncertainty: 0.012, mono: nil, bootRef: nil)
        race.crossings = [
            Crossing.manual(bib: "12", time: Date(timeIntervalSince1970: start + 1500.25), clock: clock),
            Crossing.manual(bib: "7", time: Date(timeIntervalSince1970: start + 1432.5), clock: clock),
        ]

        // First upload: everything.
        let first = HubPlanner.push(for: race, station: "Finish", timeZone: "UTC", known: nil)
        let firstReply = try await client.send(first, code: code, device: device)
        XCTAssertEqual(firstReply.count, 2)
        var known = try XCTUnwrap(HubPlanner.state(after: first, reply: firstReply, known: nil))
        let afterFirst = try await csv(client, code: code)
        XCTAssertEqual(afterFirst, "bib,time_of_day,elapsed,station\r\n7,00:23:52.500,0:23:52.500,Finish\r\n12,00:25:00.250,0:25:00.250,Finish\r\n")

        // A correction, a deletion and a new result travel as changes only.
        race.crossings[0].bib = "21"
        race.crossings.remove(at: 1)
        race.crossings.append(Crossing.manual(bib: "33", time: Date(timeIntervalSince1970: start + 1600), clock: clock))
        let second = HubPlanner.push(for: race, station: "Finish", timeZone: "UTC", known: known)
        XCTAssertFalse(second.full)
        XCTAssertEqual(second.crossings.count, 2)
        XCTAssertEqual(second.deleted.count, 1)
        let secondReply = try await client.send(second, code: code, device: device)
        XCTAssertEqual(secondReply.count, 2)
        XCTAssertEqual(secondReply.store, firstReply.store)
        known = try XCTUnwrap(HubPlanner.state(after: second, reply: secondReply, known: known))
        let afterSecond = try await csv(client, code: code)
        XCTAssertEqual(afterSecond, "bib,time_of_day,elapsed,station\r\n21,00:25:00.250,0:25:00.250,Finish\r\n33,00:26:40.000,0:26:40.000,Finish\r\n")

        // With nothing new, the upload is only a sign of life and changes nothing.
        let idle = HubPlanner.push(for: race, station: "Finish", timeZone: "UTC", known: known)
        XCTAssertTrue(idle.isHeartbeat)
        let idleReply = try await client.send(idle, code: code, device: device)
        XCTAssertEqual(idleReply.count, 2)
        XCTAssertNotNil(HubPlanner.state(after: idle, reply: idleReply, known: known))

        // A second iPad at the same event is merged in, not mixed up.
        var other = Race(name: "Integration Dash")
        other.crossings = [Crossing.manual(bib: "7", time: Date(timeIntervalSince1970: start + 1433), clock: clock)]
        let otherPush = HubPlanner.push(for: other, station: "Finish B", timeZone: "UTC", known: nil)
        let otherReply = try await client.send(otherPush, code: code, device: UUID().uuidString)
        XCTAssertEqual(otherReply.count, 1)
        let merged = try await csv(client, code: code, query: "format=detailed")
        let lines = merged.components(separatedBy: "\r\n")
        XCTAssertEqual(lines.count, 5)
        XCTAssertEqual(lines[1], "1,7,00:23:53.000,0:23:53.000,2021-01-01T00:23:53.000Z,manual,manual,,ntp,12,Finish B,")
        XCTAssertEqual(lines[2], "2,21,00:25:00.250,0:25:00.250,2021-01-01T00:25:00.250Z,manual,manual,,ntp,12,Finish,")
    }

    func testAnInvalidEventCodeIsRefused() async throws {
        let client = try client()
        let push = HubPlanner.push(for: Race(name: "Bad"), station: "Finish", timeZone: "UTC", known: nil)
        do {
            _ = try await client.send(push, code: "Not A Code", device: UUID().uuidString)
            XCTFail("an invalid code was accepted")
        } catch let failure as HubClient.Failure {
            guard case .refused(400, let message) = failure else {
                return XCTFail("expected a refusal, got \(failure)")
            }
            XCTAssertFalse(message.isEmpty)
        }
    }
}

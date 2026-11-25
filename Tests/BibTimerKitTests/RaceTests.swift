import XCTest
@testable import BibTimerKit

final class RaceTests: XCTestCase {
    private let base = 1_800_000_000.0

    private func report(_ trackID: Int, _ bib: String, at seconds: Double, ended: Bool = false, sightings: Int = 3) -> TrackReport {
        let time = Date(timeIntervalSince1970: base + seconds)
        return TrackReport(
            trackID: trackID, bib: bib, time: time, timing: .line,
            clock: ClockStamp(source: .ntp, uncertainty: 0.01, mono: seconds, bootRef: base),
            firstSeen: time.addingTimeInterval(-1), lastSeen: time.addingTimeInterval(1),
            sightings: sightings, confidence: 1, ended: ended
        )
    }

    // MARK: Ledger

    func testEachBibIsRecordedOnceByDefault() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        guard case .added(let id) = ledger.apply(report(1, "101", at: 0, ended: true), to: &crossings, rule: rule) else {
            return XCTFail("the first sighting should be recorded")
        }
        XCTAssertEqual(crossings.map(\.id), [id])
        XCTAssertEqual(crossings.first?.source, .camera)
        XCTAssertEqual(crossings.first?.timing, .line)

        // The same runner wanders back into view minutes later.
        XCTAssertEqual(ledger.apply(report(2, "101", at: 300), to: &crossings, rule: rule), .none)
        XCTAssertEqual(ledger.apply(report(3, "102", at: 301), to: &crossings, rule: rule), .added(crossings.last?.id ?? UUID()))
        XCTAssertEqual(crossings.map(\.bib), ["101", "102"])
    }

    func testLapsNeedAMinimumInterval() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule(allowRepeats: true, minInterval: 30)

        _ = ledger.apply(report(1, "101", at: 0, ended: true), to: &crossings, rule: rule)
        XCTAssertEqual(ledger.apply(report(2, "101", at: 10, ended: true), to: &crossings, rule: rule), .none)
        _ = ledger.apply(report(3, "101", at: 45, ended: true), to: &crossings, rule: rule)
        XCTAssertEqual(crossings.map(\.bib), ["101", "101"])
        XCTAssertEqual(crossings.map { $0.time.timeIntervalSince1970 - base }, [0, 45])
    }

    func testACorrectedNumberUpdatesTheSameCrossing() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        _ = ledger.apply(report(1, "123", at: 5), to: &crossings, rule: rule)
        let id = crossings[0].id
        XCTAssertEqual(ledger.apply(report(1, "1234", at: 5, sightings: 6), to: &crossings, rule: rule), .updated(id))
        XCTAssertEqual(crossings.count, 1)
        XCTAssertEqual(crossings[0].bib, "1234")
        XCTAssertEqual(crossings[0].sightings, 6)
        // Nothing changed: nothing to report.
        XCTAssertEqual(ledger.apply(report(1, "1234", at: 5, sightings: 6), to: &crossings, rule: rule), .none)
    }

    func testAMisreadOfARecordedBibIsWithdrawn() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        _ = ledger.apply(report(1, "1234", at: 0, ended: true), to: &crossings, rule: rule)
        // The finisher is seen again, at first with a digit hidden.
        _ = ledger.apply(report(2, "123", at: 20), to: &crossings, rule: rule)
        XCTAssertEqual(crossings.map(\.bib), ["1234", "123"])
        let misread = crossings[1].id
        XCTAssertEqual(ledger.apply(report(2, "1234", at: 20), to: &crossings, rule: rule), .removed(misread))
        XCTAssertEqual(crossings.map(\.bib), ["1234"])
        XCTAssertEqual(ledger.apply(report(2, "1234", at: 20, ended: true), to: &crossings, rule: rule), .none)
        XCTAssertEqual(crossings.count, 1)
    }

    func testASuppressedTrackIsRecordedOnceItsNumberChanges() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        _ = ledger.apply(report(1, "101", at: 0, ended: true), to: &crossings, rule: rule)
        XCTAssertEqual(ledger.apply(report(2, "101", at: 50), to: &crossings, rule: rule), .none)
        _ = ledger.apply(report(2, "107", at: 50), to: &crossings, rule: rule)
        XCTAssertEqual(crossings.map(\.bib), ["101", "107"])
    }

    func testANumberCorrectedByHandIsNotOverwritten() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        _ = ledger.apply(report(1, "123", at: 5), to: &crossings, rule: rule)
        crossings[0].detectedBib = crossings[0].bib
        crossings[0].bib = "128"
        _ = ledger.apply(report(1, "1234", at: 5, ended: true, sightings: 9), to: &crossings, rule: rule)
        XCTAssertEqual(crossings[0].bib, "128")
        XCTAssertEqual(crossings[0].detectedBib, "123")
        XCTAssertEqual(crossings[0].sightings, 9)
    }

    func testADeletedCrossingStaysDeletedWhileTheBibIsInView() {
        var ledger = CrossingLedger()
        var crossings: [Crossing] = []
        let rule = RepeatRule()

        _ = ledger.apply(report(1, "55", at: 0), to: &crossings, rule: rule)
        crossings.removeAll()
        XCTAssertEqual(ledger.apply(report(1, "55", at: 0), to: &crossings, rule: rule), .none)
        XCTAssertEqual(ledger.apply(report(1, "55", at: 0, ended: true), to: &crossings, rule: rule), .none)
        XCTAssertTrue(crossings.isEmpty)
        // A fresh sighting after it left the frame is recorded again.
        _ = ledger.apply(report(2, "55", at: 60), to: &crossings, rule: rule)
        XCTAssertEqual(crossings.map(\.bib), ["55"])
    }

    // MARK: Race

    private func crossing(_ bib: String, at seconds: Double, clock: ClockStamp? = nil) -> Crossing {
        Crossing.manual(bib: bib, time: Date(timeIntervalSince1970: base + seconds),
                        clock: clock ?? ClockStamp(source: .ntp, uncertainty: 0.01, mono: nil, bootRef: nil))
    }

    func testCrossingsSortByTime() {
        var race = Race(name: "Test")
        race.crossings = [crossing("3", at: 30), crossing("1", at: 10), crossing("2", at: 20)]
        XCTAssertEqual(race.sortedCrossings.map(\.bib), ["1", "2", "3"])
    }

    func testDuplicateBibsAreFound() {
        var race = Race(name: "Test")
        race.crossings = [crossing("7", at: 1), crossing("8", at: 2), crossing("7", at: 3), crossing("", at: 4), crossing("", at: 5)]
        XCTAssertEqual(race.duplicateBibs, ["7"])
    }

    func testRosterRestriction() {
        var race = Race(name: "Test")
        XCTAssertNil(race.acceptedBibs)
        race.roster = [RosterEntry(bib: "1", name: "Ana"), RosterEntry(bib: "2", name: "Ben")]
        XCTAssertNil(race.acceptedBibs)
        race.restrictToRoster = true
        XCTAssertEqual(race.acceptedBibs, ["1", "2"])
        XCTAssertEqual(race.rosterNames["2"], "Ben")
    }

    func testDeviceClockTimesAreCorrectedFromALaterFix() {
        // The device's wall clock is 2.5 s fast; its boot reference is `boot`.
        let boot = base + 2.5
        var race = Race(name: "Test")
        race.crossings = [
            crossing("1", at: 100 + 2.5, clock: ClockStamp(source: .device, uncertainty: nil, mono: 100, bootRef: boot)),
            // Captured before a reboot: cannot be corrected.
            crossing("2", at: 50, clock: ClockStamp(source: .device, uncertainty: nil, mono: 9000, bootRef: boot - 20_000)),
            crossing("3", at: 200, clock: ClockStamp(source: .ntp, uncertainty: 0.02, mono: 200, bootRef: boot)),
        ]
        XCTAssertEqual(race.deviceClockCount, 2)

        let fix = ClockFix(utcMinusMono: base, uncertainty: 0.015, monoTime: 400, wallTime: 400 + boot,
                           server: "test", stratum: 2, delay: 0.02, agreeing: 2, responding: 2)
        XCTAssertEqual(race.retime(with: fix), 1)

        XCTAssertEqual(race.crossings[0].time.timeIntervalSince1970, base + 100, accuracy: 1e-6)
        XCTAssertEqual(race.crossings[0].clock.source, .ntp)
        XCTAssertEqual(race.crossings[0].clock.uncertainty ?? 0, 0.015 + 300 * 20e-6, accuracy: 1e-9)
        XCTAssertEqual(race.crossings[1].clock.source, .device)
        XCTAssertEqual(race.crossings[1].time.timeIntervalSince1970, base + 50, accuracy: 1e-6)
        XCTAssertEqual(race.crossings[2].time.timeIntervalSince1970, base + 200, accuracy: 1e-6)
        XCTAssertEqual(race.deviceClockCount, 1)
    }

    func testRaceSurvivesSavingAndLoading() throws {
        var race = Race(name: "Round trip")
        race.startTime = Date(timeIntervalSince1970: base)
        race.roster = [RosterEntry(bib: "1", name: "Ana")]
        race.crossings = [crossing("1", at: 12.345)]

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let loaded = try decoder.decode(Race.self, from: encoder.encode(race))

        XCTAssertEqual(loaded.id, race.id)
        XCTAssertEqual(loaded.name, race.name)
        XCTAssertEqual(loaded.roster, race.roster)
        XCTAssertEqual(loaded.crossings.count, 1)
        XCTAssertEqual(loaded.crossings[0].bib, "1")
        XCTAssertEqual(loaded.crossings[0].time.timeIntervalSince1970, base + 12.345, accuracy: 1e-4)
        XCTAssertEqual(loaded.startTime?.timeIntervalSince1970 ?? 0, base, accuracy: 1e-4)
    }

    // MARK: Roster

    func testRosterParsing() {
        let text = """
        Bib,Name
        101,Jane Doe
        102;John;Smith
        103\tAna\tLima
        104 Bob Stone
        #105
        101,Duplicate

        not a runner
        007,"James Bond"
        """
        let roster = RosterParser.parse(text)
        XCTAssertEqual(roster.map(\.bib), ["101", "102", "103", "104", "105", "7"])
        XCTAssertEqual(roster.map(\.name), ["Jane Doe", "John Smith", "Ana Lima", "Bob Stone", "", "James Bond"])
    }

    func testRosterParsingHandlesWindowsLineEndings() {
        let roster = RosterParser.parse("1,Ana\r\n2,Ben\r\n")
        XCTAssertEqual(roster, [RosterEntry(bib: "1", name: "Ana"), RosterEntry(bib: "2", name: "Ben")])
    }

    func testRosterParsingSkipsTheInvisibleMarkSpreadsheetsPutFirst() {
        // Files saved as "CSV UTF-8" start with a byte order mark, which
        // would otherwise hide the first runner's bib number.
        let roster = RosterParser.parse("\u{FEFF}101,Jane Doe\r\n102,John Smith\r\n")
        XCTAssertEqual(roster, [RosterEntry(bib: "101", name: "Jane Doe"), RosterEntry(bib: "102", name: "John Smith")])
    }
}

import XCTest
@testable import BibTimerKit

final class ExportTests: XCTestCase {
    private let utc = TimeZone(secondsFromGMT: 0)!
    private let newYear2021 = 1_609_459_200.0

    private func date(_ seconds: Double) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    // MARK: Time formatting

    func testISOTimestamps() {
        XCTAssertEqual(TimeFormat.isoUTC(date(0)), "1970-01-01T00:00:00.000Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(newYear2021 + 0.123)), "2021-01-01T00:00:00.123Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(newYear2021 - 0.5)), "2020-12-31T23:59:59.500Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(951_782_400)), "2000-02-29T00:00:00.000Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(1_709_208_000)), "2024-02-29T12:00:00.000Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(4_107_542_400)), "2100-03-01T00:00:00.000Z")
        XCTAssertEqual(TimeFormat.isoUTC(date(-0.5)), "1969-12-31T23:59:59.500Z")
    }

    func testCivilDates() {
        XCTAssertTrue(TimeFormat.civilDate(daysSinceEpoch: 0) == (1970, 1, 1))
        XCTAssertTrue(TimeFormat.civilDate(daysSinceEpoch: 365) == (1971, 1, 1))
        XCTAssertTrue(TimeFormat.civilDate(daysSinceEpoch: 11_016) == (2000, 2, 29))
        XCTAssertTrue(TimeFormat.civilDate(daysSinceEpoch: 11_017) == (2000, 3, 1))
        XCTAssertTrue(TimeFormat.civilDate(daysSinceEpoch: -1) == (1969, 12, 31))
    }

    func testTimeOfDayInATimeZone() {
        let newYorkWinter = TimeZone(secondsFromGMT: -5 * 3600)!
        let instant = date(newYear2021 + 0.123)
        XCTAssertEqual(TimeFormat.timeOfDay(instant, timeZone: utc), "00:00:00.123")
        XCTAssertEqual(TimeFormat.timeOfDay(instant, timeZone: newYorkWinter), "19:00:00.123")
        XCTAssertEqual(TimeFormat.timeOfDay(instant, timeZone: newYorkWinter, decimals: 1), "19:00:00.1")
        XCTAssertEqual(TimeFormat.timeOfDay(instant, timeZone: newYorkWinter, decimals: 0), "19:00:00")
        XCTAssertEqual(TimeFormat.localDate(instant, timeZone: newYorkWinter), "2020-12-31")
        XCTAssertEqual(TimeFormat.localDate(instant, timeZone: utc), "2021-01-01")
    }

    func testElapsedTimes() {
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: 0), "0:00:00.000")
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: 5_025_678), "1:23:45.678")
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: 5_025_678, decimals: 1), "1:23:45.6")
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: 5_025_678, decimals: 2), "1:23:45.67")
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: -1500), "-0:00:01.500")
        XCTAssertEqual(TimeFormat.elapsed(milliseconds: 36_000_000 * 3), "30:00:00.000")
        XCTAssertEqual(TimeFormat.elapsed(from: date(newYear2021), to: date(newYear2021 + 1432.5)), "0:23:52.500")
    }

    func testParsingATimeOfDay() {
        XCTAssertEqual(TimeFormat.parseTimeOfDay("9:30"), 34_200)
        XCTAssertEqual(TimeFormat.parseTimeOfDay(" 09:30:15.25 "), 34_215.25)
        XCTAssertEqual(TimeFormat.parseTimeOfDay("23:59:59"), 86_399)
        XCTAssertNil(TimeFormat.parseTimeOfDay("24:00"))
        XCTAssertNil(TimeFormat.parseTimeOfDay("9"))
        XCTAssertNil(TimeFormat.parseTimeOfDay("9:61"))
        XCTAssertNil(TimeFormat.parseTimeOfDay("9:30:60"))
        XCTAssertNil(TimeFormat.parseTimeOfDay("nine:thirty"))
        XCTAssertNil(TimeFormat.parseTimeOfDay(""))
    }

    /// The moment as seconds since 1970; fails the test if there is none.
    private func seconds(_ moment: Date?, file: StaticString = #filePath, line: UInt = #line) throws -> Double {
        try XCTUnwrap(moment, file: file, line: line).timeIntervalSince1970
    }

    func testATypedTimeOfDayBecomesAMomentOnThatDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let noon = date(newYear2021 + 12 * 3600)
        XCTAssertEqual(try seconds(TimeFormat.moment(on: noon, secondsIntoDay: 34_200, calendar: calendar)), newYear2021 + 34_200, accuracy: 1e-6)
        XCTAssertEqual(try seconds(TimeFormat.moment(on: noon, secondsIntoDay: 0, calendar: calendar)), newYear2021, accuracy: 1e-6)
        XCTAssertEqual(try seconds(TimeFormat.moment(on: noon, secondsIntoDay: 86_399.5, calendar: calendar)), newYear2021 + 86_399.5, accuracy: 1e-6)
        XCTAssertNil(TimeFormat.moment(on: noon, secondsIntoDay: 86_400, calendar: calendar))
        XCTAssertNil(TimeFormat.moment(on: noon, secondsIntoDay: -1, calendar: calendar))
    }

    func testATypedTimeOfDayIsRightOnTheDayTheClocksChange() throws {
        guard let newYork = TimeZone(identifier: "America/New_York") else {
            throw XCTSkip("this machine has no time zone data")
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = newYork
        // Sunday 1 November 2026: at 2:00 the clocks in New York go back an
        // hour, so 9:30 comes ten and a half hours after midnight.
        let thatDay = date(1_793_534_400) // 12:00 UTC, 7:00 in New York
        XCTAssertEqual(try seconds(TimeFormat.moment(on: thatDay, secondsIntoDay: 0, calendar: calendar)), 1_793_505_600, accuracy: 1e-6)
        let halfPastNine = try XCTUnwrap(TimeFormat.moment(on: thatDay, secondsIntoDay: 34_200.25, calendar: calendar))
        XCTAssertEqual(halfPastNine.timeIntervalSince1970, 1_793_543_400.25, accuracy: 1e-6)
        XCTAssertEqual(TimeFormat.timeOfDay(halfPastNine, timeZone: newYork, decimals: 2), "09:30:00.25")
        XCTAssertEqual(TimeFormat.localDate(halfPastNine, timeZone: newYork), "2026-11-01")
    }

    // MARK: CSV

    private func crossing(_ bib: String, at seconds: Double) -> Crossing {
        Crossing.manual(bib: bib, time: date(newYear2021 + seconds),
                        clock: ClockStamp(source: .ntp, uncertainty: 0.0124, mono: nil, bootRef: nil))
    }

    func testSimpleExportIsInFinishingOrder() {
        var race = Race(name: "Test", createdAt: date(newYear2021))
        race.startTime = date(newYear2021)
        race.crossings = [crossing("12", at: 1500.25), crossing("7", at: 1432.5)]

        let csv = CSVExport.csv(for: race, station: "Finish", format: .simple, timeZone: utc)
        XCTAssertEqual(csv, "bib,time_of_day,elapsed\r\n7,00:23:52.500,0:23:52.500\r\n12,00:25:00.250,0:25:00.250\r\n")
    }

    func testExportWithoutAStartTimeLeavesElapsedEmpty() {
        var race = Race(name: "Test", createdAt: date(newYear2021))
        race.crossings = [crossing("7", at: 60)]
        let csv = CSVExport.csv(for: race, station: "Finish", format: .simple, timeZone: utc)
        XCTAssertEqual(csv, "bib,time_of_day,elapsed\r\n7,00:01:00.000,\r\n")
    }

    func testDetailedExport() {
        var race = Race(name: "Test", createdAt: date(newYear2021))
        race.startTime = date(newYear2021)
        race.roster = [RosterEntry(bib: "7", name: "Doe, Jane")]
        var first = crossing("7", at: 1432.5)
        first.note = "said \"go\""
        first.detectedBib = "1"
        var second = Crossing(
            id: UUID(), bib: "12", time: date(newYear2021 + 1500.25), timing: .line, source: .camera,
            clock: ClockStamp(source: .device, uncertainty: nil, mono: nil, bootRef: nil),
            confidence: 0.5, sightings: 8, firstSeen: nil, lastSeen: nil, detectedBib: nil, note: "", photo: nil
        )
        second.note = "=SUM(A1)"
        race.crossings = [second, first]

        let csv = CSVExport.csv(for: race, station: "Finish A", format: .detailed, timeZone: utc)
        let lines = csv.components(separatedBy: "\r\n")
        XCTAssertEqual(lines.count, 4)
        XCTAssertEqual(lines[0], CSVExport.detailedHeader.joined(separator: ","))
        XCTAssertEqual(lines[1], "1,7,\"Doe, Jane\",00:23:52.500,0:23:52.500,2021-01-01T00:23:52.500Z,manual,manual,,,ntp,12,1,Finish A,\"said \"\"go\"\"\"")
        XCTAssertEqual(lines[2], "2,12,,00:25:00.250,0:25:00.250,2021-01-01T00:25:00.250Z,line,camera,0.50,8,device,,,Finish A,'=SUM(A1)")
        XCTAssertEqual(lines[3], "")
    }

    func testEscaping() {
        XCTAssertEqual(CSVExport.escape("plain"), "plain")
        XCTAssertEqual(CSVExport.escape("a,b"), "\"a,b\"")
        XCTAssertEqual(CSVExport.escape("say \"hi\""), "\"say \"\"hi\"\"\"")
        XCTAssertEqual(CSVExport.escape("two\nlines"), "\"two\nlines\"")
    }

    func testFileName() {
        let race = Race(name: "Spring 5K / Fun Run", createdAt: date(newYear2021))
        XCTAssertEqual(CSVExport.fileName(for: race, station: "Finish A", timeZone: utc), "Spring-5K-Fun-Run_Finish-A_2021-01-01.csv")
        XCTAssertEqual(CSVExport.fileName(for: Race(name: "", createdAt: date(newYear2021)), station: "", timeZone: utc), "2021-01-01.csv")
    }
}

import XCTest
@testable import BibTimerKit

private struct FakeClock: MonotonicClock {
    var value: Double
    func now() -> TimeInterval { value }
}

final class ClockTests: XCTestCase {
    private func makeFix(offset: Double = 1_800_000_000, uncertainty: Double = 0.010, mono: Double = 500, wall: Double? = nil) -> ClockFix {
        ClockFix(utcMinusMono: offset, uncertainty: uncertainty, monoTime: mono, wallTime: wall ?? (mono + offset),
                 server: "test", stratum: 2, delay: 0.02, agreeing: 1, responding: 1)
    }

    func testSystemMonotonicClockAdvances() {
        let clock = SystemMonotonicClock()
        let first = clock.now()
        let second = clock.now()
        XCTAssertGreaterThan(first, 0)
        XCTAssertGreaterThanOrEqual(second, first)
    }

    func testFixConvertsMonotonicTimeToUTC() {
        let fix = makeFix()
        XCTAssertEqual(fix.date(atMono: 512.5).timeIntervalSince1970, 1_800_000_512.5, accuracy: 1e-6)
        XCTAssertEqual(fix.deviceClockError, 0, accuracy: 1e-6)
        // The device clock read 0.75 s more than NTP time when the fix was taken.
        XCTAssertEqual(makeFix(wall: 1_800_000_500.75).deviceClockError, 0.75, accuracy: 1e-6)
    }

    func testUncertaintyGrowsAsTheFixAges() {
        let fix = makeFix()
        XCTAssertEqual(fix.uncertainty(atMono: 500), 0.010, accuracy: 1e-9)
        // One hour at 20 parts per million adds 72 ms.
        XCTAssertEqual(fix.uncertainty(atMono: 500 + 3600), 0.082, accuracy: 1e-9)
        XCTAssertEqual(fix.uncertainty(atMono: 500 - 3600), 0.082, accuracy: 1e-9)
    }

    func testFixIsDiscardedAfterAReboot() {
        let fix = makeFix()
        let offset = 1_800_000_000.0
        // Same boot, later, with the wall clock nudged by 0.3 s.
        XCTAssertTrue(fix.isUsable(nowMono: 900, nowWall: 900 + offset + 0.3))
        // The monotonic clock went backwards: the device restarted.
        XCTAssertFalse(fix.isUsable(nowMono: 40, nowWall: offset + 4000))
        // Restarted and then stayed up longer than before the fix.
        XCTAssertFalse(fix.isUsable(nowMono: 2000, nowWall: offset + 500 + 86_400))
    }

    func testReplacementPolicy() {
        let current = makeFix(uncertainty: 0.010, mono: 500)
        let offset = 1_800_000_000.0
        // A minute later the old fix is good to about 11 ms.
        XCTAssertTrue(current.shouldBeReplaced(by: makeFix(uncertainty: 0.008, mono: 560), nowMono: 560))
        XCTAssertFalse(current.shouldBeReplaced(by: makeFix(uncertainty: 0.050, mono: 560), nowMono: 560))
        // A less precise fix still wins if the two cannot both be right.
        XCTAssertTrue(current.shouldBeReplaced(by: makeFix(offset: offset + 0.5, uncertainty: 0.050, mono: 560), nowMono: 560))
        // Two hours later the old fix has aged past the new one's precision.
        XCTAssertTrue(current.shouldBeReplaced(by: makeFix(uncertainty: 0.050, mono: 7700), nowMono: 7700))
    }

    func testRaceClockFallsBackToTheDeviceClock() {
        // Monotonic clock at 600 s; the device's wall clock is 3 s fast.
        let clock = RaceClock(monotonic: FakeClock(value: 600), wall: { 1_800_000_603 })

        let before = clock.stamp(mono: 590)
        XCTAssertEqual(before.clock.source, .device)
        XCTAssertNil(before.clock.uncertainty)
        XCTAssertEqual(before.date.timeIntervalSince1970, 1_800_000_593, accuracy: 1e-6)
        XCTAssertEqual(before.clock.mono, 590)
        XCTAssertEqual(before.clock.bootRef ?? 0, 1_800_000_003, accuracy: 1e-6)

        clock.setFix(makeFix(offset: 1_800_000_000, uncertainty: 0.010, mono: 580))
        let after = clock.stamp(mono: 590)
        XCTAssertEqual(after.clock.source, .ntp)
        XCTAssertEqual(after.date.timeIntervalSince1970, 1_800_000_590, accuracy: 1e-6)
        XCTAssertEqual(after.clock.uncertainty ?? 0, 0.0102, accuracy: 1e-9)
        XCTAssertEqual(clock.now().date.timeIntervalSince1970, 1_800_000_600, accuracy: 1e-6)

        clock.setFix(nil)
        XCTAssertEqual(clock.now().clock.source, .device)
    }
}

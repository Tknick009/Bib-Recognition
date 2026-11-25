import XCTest
@testable import BibTimerKit

final class BibTrackerTests: XCTestCase {
    /// A level line 60 % of the way down the frame; bibs approach from above.
    private let line = FinishLine(a: NormPoint(x: 0, y: 0.6), b: NormPoint(x: 1, y: 0.6), reversed: false)

    private func detection(_ bib: String, x: Double = 0.5, y: Double, confidence: Double = 1) -> BibDetection {
        BibDetection(bib: bib, confidence: confidence, box: NormRect(x: x - 0.05, y: y - 0.02, width: 0.10, height: 0.04))
    }

    private func makeTracker(_ mode: TimingMode = .line, reversed: Bool = false) -> BibTracker {
        var line = self.line
        line.reversed = reversed
        return BibTracker(config: TrackerConfig(mode: mode, line: line))
    }

    func testTimeIsInterpolatedAtTheFinishLine() {
        var tracker = makeTracker()
        var events: [TrackSnapshot] = []
        // The bib moves down the frame at one frame height per second and is
        // read every 0.1 s. It reaches the line (y = 0.6) at 10.27 s.
        for step in 0...5 {
            let time = 10 + Double(step) * 0.1
            let y = 0.33 + Double(step) * 0.1
            events += tracker.process(time: time, detections: [detection("101", y: y)]).events
        }

        XCTAssertEqual(events.count, 1)
        guard let event = events.first else { return }
        XCTAssertEqual(event.bib, "101")
        XCTAssertEqual(event.timing, .line)
        XCTAssertTrue(event.isNew)
        XCTAssertFalse(event.ended)
        XCTAssertEqual(event.time, 10.27, accuracy: 1e-6)
        XCTAssertEqual(event.firstSeen, 10, accuracy: 1e-9)

        // Once the bib has been gone for a while the track is closed.
        let later = tracker.process(time: 13, detections: []).events
        XCTAssertEqual(later.count, 1)
        XCTAssertEqual(later.first?.ended, true)
        XCTAssertEqual(later.first?.isNew, false)
        XCTAssertEqual(later.first?.sightings, 6)
        XCTAssertEqual(later.first?.time ?? 0, 10.27, accuracy: 1e-6)
        XCTAssertEqual(tracker.activeTrackCount, 0)
    }

    func testBibLostBeforeTheLineGetsItsLastSighting() {
        var tracker = makeTracker()
        XCTAssertTrue(tracker.process(time: 1.0, detections: [detection("7", y: 0.30)]).events.isEmpty)
        XCTAssertTrue(tracker.process(time: 1.1, detections: [detection("7", y: 0.40)]).events.isEmpty)
        XCTAssertTrue(tracker.process(time: 1.2, detections: [detection("7", y: 0.50)]).events.isEmpty)
        // Still within the timeout: nothing yet.
        XCTAssertTrue(tracker.process(time: 3.0, detections: []).events.isEmpty)

        let events = tracker.process(time: 3.5, detections: []).events
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.timing, .estimated)
        XCTAssertEqual(events.first?.time ?? 0, 1.2, accuracy: 1e-9)
        XCTAssertEqual(events.first?.isNew, true)
        XCTAssertEqual(events.first?.ended, true)
    }

    func testBibHiddenForAMomentIsStillTimedAtTheLine() {
        var tracker = makeTracker()
        // Read twice on the way in, hidden behind another runner for 1.5 s,
        // then read again past the line.
        XCTAssertTrue(tracker.process(time: 1.0, detections: [detection("64", y: 0.30)]).events.isEmpty)
        XCTAssertTrue(tracker.process(time: 1.1, detections: [detection("64", y: 0.35)]).events.isEmpty)
        for step in 1...14 {
            XCTAssertTrue(tracker.process(time: 1.1 + Double(step) * 0.1, detections: []).events.isEmpty)
        }
        let events = tracker.process(time: 2.6, detections: [detection("64", y: 0.85)]).events
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.timing, .line)
        // Half-way between the two sightings either side of the line.
        XCTAssertEqual(events.first?.time ?? 0, 1.85, accuracy: 1e-6)
        XCTAssertEqual(tracker.activeTrackCount, 1)
    }

    func testBibFirstReadPastTheLineGetsItsFirstSighting() {
        var tracker = makeTracker()
        XCTAssertTrue(tracker.process(time: 5.0, detections: [detection("88", y: 0.70)]).events.isEmpty)
        let events = tracker.process(time: 5.1, detections: [detection("88", y: 0.75)]).events
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.timing, .estimated)
        XCTAssertEqual(events.first?.time ?? 0, 5.0, accuracy: 1e-9)
        XCTAssertEqual(events.first?.isNew, true)
        XCTAssertEqual(events.first?.ended, false)
    }

    func testReversedLineCountsTheOppositeDirection() {
        var tracker = makeTracker(reversed: true)
        var events: [TrackSnapshot] = []
        // Moving up the frame: 0.80, 0.70, 0.60, 0.50 … crosses y = 0.6 at 2.2 s.
        for step in 0...4 {
            events += tracker.process(time: 2 + Double(step) * 0.1, detections: [detection("5", y: 0.8 - Double(step) * 0.1)]).events
        }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.timing, .line)
        XCTAssertEqual(events.first?.time ?? 0, 2.2, accuracy: 1e-6)
    }

    func testASingleSightingIsNotReported() {
        var tracker = makeTracker(.firstSeen)
        XCTAssertTrue(tracker.process(time: 1, detections: [detection("404", y: 0.5)]).events.isEmpty)
        XCTAssertTrue(tracker.process(time: 5, detections: []).events.isEmpty)
        XCTAssertEqual(tracker.activeTrackCount, 0)
        XCTAssertTrue(tracker.finish().isEmpty)
    }

    func testFirstSeenAndLastSeenModes() {
        var first = makeTracker(.firstSeen)
        XCTAssertTrue(first.process(time: 2.0, detections: [detection("9", y: 0.3)]).events.isEmpty)
        let firstEvents = first.process(time: 2.1, detections: [detection("9", y: 0.3)]).events
        XCTAssertEqual(firstEvents.count, 1)
        XCTAssertEqual(firstEvents.first?.timing, .firstSeen)
        XCTAssertEqual(firstEvents.first?.time ?? 0, 2.0, accuracy: 1e-9)

        var last = makeTracker(.lastSeen)
        for step in 0...2 {
            XCTAssertTrue(last.process(time: 2 + Double(step) * 0.1, detections: [detection("9", y: 0.3)]).events.isEmpty)
        }
        let lastEvents = last.finish()
        XCTAssertEqual(lastEvents.count, 1)
        XCTAssertEqual(lastEvents.first?.timing, .lastSeen)
        XCTAssertEqual(lastEvents.first?.time ?? 0, 2.2, accuracy: 1e-9)
        XCTAssertEqual(lastEvents.first?.isNew, true)
        XCTAssertEqual(lastEvents.first?.ended, true)
        XCTAssertEqual(last.activeTrackCount, 0)
    }

    func testPartialReadsDoNotCreateASecondBib() {
        var tracker = makeTracker(.firstSeen)
        var events: [TrackSnapshot] = []
        // An arm hides the first digit in two of the frames.
        for (step, bib) in ["1234", "1234", "234", "234", "1234", "1234"].enumerated() {
            events += tracker.process(time: Double(step) * 0.1, detections: [detection(bib, y: 0.3 + Double(step) * 0.01)]).events
        }
        XCTAssertEqual(tracker.activeTrackCount, 1)
        events += tracker.finish()

        XCTAssertEqual(Set(events.map(\.trackID)).count, 1)
        XCTAssertEqual(events.map(\.bib), ["1234", "1234"])
        XCTAssertEqual(events.last?.sightings, 6)
    }

    func testNumberIsCorrectedWhenLaterReadingsDisagree() {
        var tracker = makeTracker(.firstSeen)
        var events: [TrackSnapshot] = []
        for (step, bib) in ["123", "123", "1234", "1234", "1234"].enumerated() {
            events += tracker.process(time: Double(step) * 0.1, detections: [detection(bib, y: 0.3)]).events
        }
        XCTAssertEqual(events.map(\.bib), ["123", "1234"])
        XCTAssertEqual(events.map(\.isNew), [true, false])
        XCTAssertEqual(Set(events.map(\.trackID)).count, 1)
        // The time taken at the first report does not move.
        XCTAssertEqual(events.last?.time ?? -1, 0, accuracy: 1e-9)
    }

    func testBibsSideBySideAreTrackedSeparately() {
        var tracker = makeTracker()
        var events: [TrackSnapshot] = []
        for step in 0...4 {
            let y = 0.45 + Double(step) * 0.1
            let detections = [detection("12", x: 0.3, y: y), detection("13", x: 0.7, y: y - 0.02)]
            events += tracker.process(time: Double(step) * 0.1, detections: detections).events
        }
        XCTAssertEqual(Set(events.map(\.bib)), ["12", "13"])
        XCTAssertEqual(Set(events.map(\.trackID)).count, 2)
        XCTAssertTrue(events.allSatisfy { $0.timing == .line })
    }

    func testDifferentNumbersInTheSamePlaceAreDifferentBibs() {
        var tracker = makeTracker()
        _ = tracker.process(time: 0.0, detections: [detection("45", y: 0.3)])
        _ = tracker.process(time: 0.1, detections: [detection("892", y: 0.3)])
        XCTAssertEqual(tracker.activeTrackCount, 2)
    }

    func testOverlayStates() {
        var tracker = makeTracker()
        XCTAssertEqual(tracker.process(time: 0.0, detections: [detection("31", y: 0.40)]).overlays.map(\.state), [.pending])
        XCTAssertEqual(tracker.process(time: 0.1, detections: [detection("31", y: 0.50)]).overlays.map(\.state), [.tracking])
        let crossed = tracker.process(time: 0.2, detections: [detection("31", y: 0.65)])
        XCTAssertEqual(crossed.overlays.map(\.state), [.timed])
        XCTAssertEqual(crossed.overlays.first?.bib, "31")
        XCTAssertEqual(crossed.events.count, 1)
        XCTAssertTrue(tracker.process(time: 0.3, detections: []).overlays.isEmpty)
    }

    func testSimilarity() {
        XCTAssertTrue(BibTracker.isSimilar("1234", "1234"))
        XCTAssertTrue(BibTracker.isSimilar("1234", "234"))
        XCTAssertTrue(BibTracker.isSimilar("123", "1234"))
        XCTAssertTrue(BibTracker.isSimilar("1234", "134"))
        XCTAssertTrue(BibTracker.isSimilar("1234", "1284"))
        XCTAssertFalse(BibTracker.isSimilar("1234", "1288"))
        XCTAssertFalse(BibTracker.isSimilar("45", "892"))
        XCTAssertFalse(BibTracker.isSimilar("7", "8"))
    }
}

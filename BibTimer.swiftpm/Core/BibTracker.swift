import Foundation

/// Which moment is recorded as a bib's time.
enum TimingMode: String, Codable, CaseIterable, Identifiable {
    /// When the bib crosses the virtual finish line drawn on the video.
    case line
    /// The first frame in which the bib was read.
    case firstSeen
    /// The last frame in which the bib was read.
    case lastSeen

    var id: String { rawValue }
}

/// How a recorded time was arrived at.
enum TimingKind: String, Codable {
    /// The bib was read on both sides of the finish line and the time was
    /// interpolated at the line.
    case line
    /// Finish-line mode, but the bib was only read on one side of the line, so
    /// the nearest sighting was used instead.
    case estimated
    case firstSeen
    case lastSeen
    /// Entered by hand.
    case manual
}

struct TrackerConfig: Equatable {
    var mode = TimingMode.line
    var line = FinishLine.standard
    /// Frames in which a number must be read before it is believed.
    var minSightings = 2
    /// A bib that has not been read for this long has left the frame.
    var trackTimeout: TimeInterval = 1.2
    /// How long after a sighting a slightly different number in the same place
    /// is still treated as a misread of the same bib.
    var mergeWindow: TimeInterval = 0.5
}

/// The tracker's report about one bib. The first report for a track carries
/// its time; later ones correct the number or mark the end of the track.
struct TrackSnapshot: Equatable {
    var trackID: Int
    var bib: String
    /// The timing point, in monotonic seconds.
    var time: TimeInterval
    var timing: TimingKind
    var firstSeen: TimeInterval
    var lastSeen: TimeInterval
    /// Frames in which the bib was read.
    var sightings: Int
    var confidence: Double
    var box: NormRect
    /// True for the first report about this track.
    var isNew: Bool
    /// True when the bib has left the frame; nothing more will follow.
    var ended: Bool
}

/// A bib visible in the current frame, for drawing on top of the video.
struct TrackOverlay: Equatable, Identifiable {
    enum State: Equatable {
        /// Read too few times to be believed yet.
        case pending
        /// Believed, waiting for its timing point.
        case tracking
        /// Its time has been taken.
        case timed
    }

    var id: Int
    var bib: String
    var box: NormRect
    var state: State
}

struct TrackerOutput: Equatable {
    var events: [TrackSnapshot] = []
    var overlays: [TrackOverlay] = []
}

/// Follows bib numbers from frame to frame and decides when each one's time
/// should be taken.
///
/// Readings of the same number, and slightly different readings in the same
/// place (a digit hidden by an arm, a misread), are grouped into one track. A
/// track reports the number most of its readings agree on.
struct BibTracker {
    var config: TrackerConfig

    private var tracks: [Track] = []
    private var nextID = 1

    init(config: TrackerConfig = TrackerConfig()) {
        self.config = config
    }

    var activeTrackCount: Int { tracks.count }

    /// Feeds the detections of one video frame, taken at `time` (monotonic
    /// seconds). Must be called for every analyzed frame, including frames
    /// without detections, so tracks can time out.
    mutating func process(time: TimeInterval, detections: [BibDetection]) -> TrackerOutput {
        let config = self.config
        var output = TrackerOutput()
        output.events = expire(now: time)

        var assignment = [Int?](repeating: nil, count: detections.count)
        var taken = Set<Int>()

        // A detection whose number a track has already read belongs to that track.
        var pairs: [Pair] = []
        for (d, detection) in detections.enumerated() {
            for (t, track) in tracks.enumerated() where track.readings[detection.bib] != nil {
                pairs.append(Pair(detection: d, track: t, distance: BibTracker.distance(detection.box, track.box)))
            }
        }
        BibTracker.assign(pairs, to: &assignment, taken: &taken)

        // A similar number in the same place moments later is a misread of the same bib.
        pairs.removeAll()
        for (d, detection) in detections.enumerated() where assignment[d] == nil {
            for (t, track) in tracks.enumerated() where !taken.contains(t) {
                guard time - track.lastSeen <= config.mergeWindow,
                      let best = track.best,
                      BibTracker.isSimilar(detection.bib, best.bib),
                      BibTracker.isNear(detection.box, track.box) else { continue }
                pairs.append(Pair(detection: d, track: t, distance: BibTracker.distance(detection.box, track.box)))
            }
        }
        BibTracker.assign(pairs, to: &assignment, taken: &taken)

        var touched: [Int] = []
        for (d, detection) in detections.enumerated() {
            if let t = assignment[d] {
                tracks[t].add(detection, time: time, line: config.line)
                touched.append(t)
            } else {
                tracks.append(Track(id: nextID, detection: detection, time: time, line: config.line))
                nextID += 1
                touched.append(tracks.count - 1)
            }
        }

        for t in touched {
            var track = tracks[t]
            if let event = BibTracker.report(&track, config: config, ended: false) {
                output.events.append(event)
            }
            tracks[t] = track
            output.overlays.append(track.overlay(minSightings: config.minSightings))
        }
        return output
    }

    /// Ends every track, as when recording stops. Bibs that were being
    /// followed get their best available time.
    mutating func finish() -> [TrackSnapshot] {
        let config = self.config
        var events: [TrackSnapshot] = []
        for var track in tracks {
            if let event = BibTracker.report(&track, config: config, ended: true) {
                events.append(event)
            }
        }
        tracks.removeAll()
        return events
    }

    /// Forgets every track without reporting anything.
    mutating func reset() {
        tracks.removeAll()
    }

    private mutating func expire(now: TimeInterval) -> [TrackSnapshot] {
        let config = self.config
        var events: [TrackSnapshot] = []
        var remaining: [Track] = []
        for var track in tracks {
            if now - track.lastSeen > config.trackTimeout {
                if let event = BibTracker.report(&track, config: config, ended: true) {
                    events.append(event)
                }
            } else {
                remaining.append(track)
            }
        }
        tracks = remaining
        return events
    }

    // MARK: Reporting

    /// The event to publish for a track that just changed or ended, if any.
    private static func report(_ track: inout Track, config: TrackerConfig, ended: Bool) -> TrackSnapshot? {
        guard let best = track.best, best.reading.count >= config.minSightings else { return nil }

        let isNew: Bool
        if track.timingPoint == nil {
            guard let point = timingPoint(of: track, config: config, ended: ended) else { return nil }
            track.timingPoint = point
            track.timingKind = kind(of: track, config: config)
            isNew = true
        } else {
            guard ended || track.reportedBib != best.bib else { return nil }
            isNew = false
        }
        guard let time = track.timingPoint else { return nil }
        track.reportedBib = best.bib

        return TrackSnapshot(
            trackID: track.id,
            bib: best.bib,
            time: time,
            timing: track.timingKind,
            firstSeen: track.firstSeen,
            lastSeen: track.lastSeen,
            sightings: track.frames,
            confidence: best.reading.best,
            box: track.box,
            isNew: isNew,
            ended: ended
        )
    }

    /// The moment to record for a track, once it is known.
    private static func timingPoint(of track: Track, config: TrackerConfig, ended: Bool) -> TimeInterval? {
        switch config.mode {
        case .firstSeen:
            return track.firstSeen
        case .lastSeen:
            return ended ? track.lastSeen : nil
        case .line:
            if let crossing = track.crossingTime { return crossing }
            // First read when already past the line: the first sighting is
            // the closest thing to the crossing there will ever be.
            if track.firstSide >= 0 { return track.firstSeen }
            // Still approaching: wait for the crossing. If the bib is lost
            // before it gets there, the last sighting has to do.
            return ended ? track.lastSeen : nil
        }
    }

    private static func kind(of track: Track, config: TrackerConfig) -> TimingKind {
        switch config.mode {
        case .firstSeen: return .firstSeen
        case .lastSeen: return .lastSeen
        case .line: return track.crossingTime != nil ? .line : .estimated
        }
    }

    // MARK: Association

    private struct Pair {
        var detection: Int
        var track: Int
        var distance: Double
    }

    private static func assign(_ pairs: [Pair], to assignment: inout [Int?], taken: inout Set<Int>) {
        for pair in pairs.sorted(by: { $0.distance < $1.distance }) {
            guard assignment[pair.detection] == nil, !taken.contains(pair.track) else { continue }
            assignment[pair.detection] = pair.track
            taken.insert(pair.track)
        }
    }

    static func distance(_ a: NormRect, _ b: NormRect) -> Double {
        let dx = a.midX - b.midX
        let dy = a.midY - b.midY
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Whether two boxes could be the same bib a moment apart.
    static func isNear(_ a: NormRect, _ b: NormRect) -> Bool {
        guard a.height > 0, b.height > 0 else { return false }
        let ratio = a.height / b.height
        guard ratio > 0.5, ratio < 2 else { return false }
        let width = max(a.width, b.width)
        let height = max(a.height, b.height)
        return abs(a.midX - b.midX) <= 0.75 * width && abs(a.midY - b.midY) <= height
    }

    /// Whether one number could be a misreading of the other: a single wrong
    /// digit, or digits missing (hidden by an arm or a fold in the bib).
    static func isSimilar(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let first = Array(a)
        let second = Array(b)
        if first.count == second.count {
            guard first.count >= 2 else { return false }
            var differences = 0
            for index in first.indices where first[index] != second[index] {
                differences += 1
            }
            return differences == 1
        }
        let shorter = first.count < second.count ? first : second
        let longer = first.count < second.count ? second : first
        var matched = 0
        for character in longer where matched < shorter.count && character == shorter[matched] {
            matched += 1
        }
        return matched == shorter.count
    }
}

// MARK: - Track

private struct Reading {
    var count = 0
    var weight = 0.0
    var best = 0.0
}

private struct Track {
    let id: Int
    var readings: [String: Reading] = [:]
    var firstSeen: TimeInterval
    var lastSeen: TimeInterval
    var frames = 1
    var box: NormRect
    /// Which side of the finish line the bib was on when first and last read.
    var firstSide: Double
    var lastSide: Double
    var crossingTime: TimeInterval?
    /// Set once the track's time has been reported.
    var timingPoint: TimeInterval?
    var timingKind = TimingKind.estimated
    var reportedBib: String?

    init(id: Int, detection: BibDetection, time: TimeInterval, line: FinishLine) {
        self.id = id
        firstSeen = time
        lastSeen = time
        box = detection.box
        let side = line.side(of: detection.box.center)
        firstSide = side
        lastSide = side
        readings[detection.bib] = Reading(count: 1, weight: detection.confidence, best: detection.confidence)
    }

    mutating func add(_ detection: BibDetection, time: TimeInterval, line: FinishLine) {
        var reading = readings[detection.bib] ?? Reading()
        reading.count += 1
        reading.weight += detection.confidence
        reading.best = max(reading.best, detection.confidence)
        readings[detection.bib] = reading

        let side = line.side(of: detection.box.center)
        if crossingTime == nil, lastSide < 0, side >= 0 {
            // The bib moved from the approach side to the finished side
            // between the previous sighting and this one.
            let fraction = -lastSide / (side - lastSide)
            crossingTime = lastSeen + (time - lastSeen) * fraction
        }
        lastSide = side
        lastSeen = time
        box = detection.box
        frames += 1
    }

    /// The number most readings agree on.
    var best: (bib: String, reading: Reading)? {
        var result: (bib: String, reading: Reading)?
        for (bib, reading) in readings {
            if let current = result, !Track.prefers(bib, reading, over: current.bib, current.reading) {
                continue
            }
            result = (bib, reading)
        }
        return result
    }

    private static func prefers(_ a: String, _ ra: Reading, over b: String, _ rb: Reading) -> Bool {
        if ra.weight != rb.weight { return ra.weight > rb.weight }
        if ra.count != rb.count { return ra.count > rb.count }
        // A longer number is more likely than a shorter one to be complete.
        if a.count != b.count { return a.count > b.count }
        return a < b
    }

    func overlay(minSightings: Int) -> TrackOverlay {
        let best = self.best
        let state: TrackOverlay.State
        if timingPoint != nil {
            state = .timed
        } else if let best, best.reading.count >= minSightings {
            state = .tracking
        } else {
            state = .pending
        }
        return TrackOverlay(id: id, bib: best?.bib ?? "", box: box, state: state)
    }
}

import Foundation

enum CrossingSource: String, Codable {
    case camera
    case manual
}

/// One recorded bib and its time.
///
/// Fields added in later versions must be optional so that races saved by
/// earlier versions still load.
struct Crossing: Identifiable, Codable, Equatable {
    var id: UUID
    /// The bib number; empty for a manual mark that has not been filled in.
    var bib: String
    var time: Date
    var timing: TimingKind
    var source: CrossingSource
    var clock: ClockStamp
    var confidence: Double?
    var sightings: Int?
    var firstSeen: Date?
    var lastSeen: Date?
    /// What the camera read, kept when the bib has been corrected by hand.
    var detectedBib: String?
    var note: String
    /// File name of the snapshot taken when the bib was recorded.
    var photo: String?

    /// A crossing entered by hand at the given moment.
    static func manual(bib: String, time: Date, clock: ClockStamp) -> Crossing {
        Crossing(id: UUID(), bib: bib, time: time, timing: .manual, source: .manual, clock: clock,
                 confidence: nil, sightings: nil, firstSeen: nil, lastSeen: nil,
                 detectedBib: nil, note: "", photo: nil)
    }

    /// The same crossing with its times worked out again from an NTP fix, or
    /// nil if that is not possible (the device has rebooted since, or the
    /// crossing carries no raw timestamp).
    func retimed(with fix: ClockFix) -> Crossing? {
        guard let mono = clock.mono, let bootRef = clock.bootRef,
              abs(fix.bootRef - bootRef) < ClockFix.bootTolerance else { return nil }
        let newTime = fix.date(atMono: mono)
        let shift = newTime.timeIntervalSince(time)
        var copy = self
        copy.time = newTime
        copy.firstSeen = firstSeen?.addingTimeInterval(shift)
        copy.lastSeen = lastSeen?.addingTimeInterval(shift)
        copy.clock.source = .ntp
        copy.clock.uncertainty = fix.uncertainty(atMono: mono)
        return copy
    }
}

struct RosterEntry: Codable, Equatable, Identifiable {
    var bib: String
    var name: String

    var id: String { bib }
}

struct Race: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var createdAt: Date
    /// The gun time, if it has been set. Elapsed times are measured from it.
    var startTime: Date?
    var crossings: [Crossing]
    var roster: [RosterEntry]
    /// Only accept bib numbers that are on the start list.
    var restrictToRoster: Bool

    init(id: UUID = UUID(), name: String, createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.startTime = nil
        self.crossings = []
        self.roster = []
        self.restrictToRoster = false
    }

    /// Crossings in finishing order.
    var sortedCrossings: [Crossing] {
        crossings.sorted { lhs, rhs in
            if lhs.time != rhs.time { return lhs.time < rhs.time }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }

    /// The numbers the camera may accept, or nil when anything goes.
    var acceptedBibs: Set<String>? {
        guard restrictToRoster, !roster.isEmpty else { return nil }
        return Set(roster.map(\.bib))
    }

    var rosterNames: [String: String] {
        Dictionary(roster.map { ($0.bib, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    /// Bib numbers that appear on more than one crossing.
    var duplicateBibs: Set<String> {
        var seen = Set<String>()
        var duplicates = Set<String>()
        for crossing in crossings where !crossing.bib.isEmpty {
            if !seen.insert(crossing.bib).inserted {
                duplicates.insert(crossing.bib)
            }
        }
        return duplicates
    }

    /// How many crossings were timed with the device clock rather than NTP.
    var deviceClockCount: Int {
        crossings.filter { $0.clock.source == .device }.count
    }

    /// Re-derives device-clock times from an NTP fix. Returns how many
    /// crossings were corrected.
    @discardableResult
    mutating func retime(with fix: ClockFix) -> Int {
        var corrected = 0
        for index in crossings.indices where crossings[index].clock.source == .device {
            if let updated = crossings[index].retimed(with: fix) {
                crossings[index] = updated
                corrected += 1
            }
        }
        return corrected
    }
}

/// When the same bib may be recorded more than once.
struct RepeatRule: Codable, Equatable {
    /// Off for a finish line (each bib is recorded once); on for laps.
    var allowRepeats = false
    /// With repeats on, the shortest time between two crossings of one bib.
    var minInterval: TimeInterval = 30

    init() {}

    init(allowRepeats: Bool, minInterval: TimeInterval) {
        self.allowRepeats = allowRepeats
        self.minInterval = minInterval
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = RepeatRule()
        allowRepeats = container.value(.allowRepeats, default: defaults.allowRepeats)
        minInterval = container.value(.minInterval, default: defaults.minInterval)
    }
}

/// A tracker report converted to time of day.
struct TrackReport: Equatable {
    var trackID: Int
    var bib: String
    var time: Date
    var timing: TimingKind
    var clock: ClockStamp
    var firstSeen: Date
    var lastSeen: Date
    var sightings: Int
    var confidence: Double
    var ended: Bool
}

/// A tracker report together with the photo taken for it, if any.
struct BibSighting {
    var report: TrackReport
    var photo: Data?
}

/// Turns tracker reports into crossings, applying the repeat rule and
/// following a track when its number is corrected after it was recorded.
struct CrossingLedger {
    enum Change: Equatable {
        case none
        case added(UUID)
        case updated(UUID)
        case removed(UUID)
    }

    private enum TrackState {
        /// The track produced this crossing.
        case recorded(UUID)
        /// The track's number was already recorded, so it produced nothing.
        case suppressed(bib: String)
    }

    private var states: [Int: TrackState] = [:]

    mutating func reset() {
        states.removeAll()
    }

    mutating func apply(_ report: TrackReport, to crossings: inout [Crossing], rule: RepeatRule) -> Change {
        let change = resolve(report, &crossings, rule)
        if report.ended {
            states[report.trackID] = nil
        }
        return change
    }

    private mutating func resolve(_ report: TrackReport, _ crossings: inout [Crossing], _ rule: RepeatRule) -> Change {
        switch states[report.trackID] {
        case .none:
            return record(report, &crossings, rule)

        case .some(.suppressed(let bib)):
            // Still the number that was already recorded: nothing to do.
            return bib == report.bib ? .none : record(report, &crossings, rule)

        case .some(.recorded(let id)):
            // Deleted by hand while the bib was still in view: leave it deleted.
            guard let index = crossings.firstIndex(where: { $0.id == id }) else { return .none }
            var crossing = crossings[index]
            // A number corrected by hand is never overwritten by the camera.
            if crossing.detectedBib == nil, crossing.bib != report.bib {
                if CrossingLedger.isBlocked(report.bib, at: crossing.time, in: crossings, excluding: id, rule: rule) {
                    // The track turned out to be a bib that is already
                    // recorded; its crossing was a misread.
                    crossings.remove(at: index)
                    states[report.trackID] = .suppressed(bib: report.bib)
                    return .removed(id)
                }
                crossing.bib = report.bib
            }
            crossing.lastSeen = report.lastSeen
            crossing.sightings = report.sightings
            crossing.confidence = report.confidence
            guard crossing != crossings[index] else { return .none }
            crossings[index] = crossing
            return .updated(id)
        }
    }

    private mutating func record(_ report: TrackReport, _ crossings: inout [Crossing], _ rule: RepeatRule) -> Change {
        if CrossingLedger.isBlocked(report.bib, at: report.time, in: crossings, excluding: nil, rule: rule) {
            states[report.trackID] = .suppressed(bib: report.bib)
            return .none
        }
        let crossing = Crossing(
            id: UUID(), bib: report.bib, time: report.time, timing: report.timing, source: .camera,
            clock: report.clock, confidence: report.confidence, sightings: report.sightings,
            firstSeen: report.firstSeen, lastSeen: report.lastSeen, detectedBib: nil, note: "", photo: nil
        )
        crossings.append(crossing)
        states[report.trackID] = .recorded(crossing.id)
        return .added(crossing.id)
    }

    /// Whether the repeat rule forbids another crossing for this bib.
    static func isBlocked(_ bib: String, at time: Date, in crossings: [Crossing], excluding: UUID?, rule: RepeatRule) -> Bool {
        crossings.contains { other in
            guard other.bib == bib, other.id != excluding else { return false }
            guard rule.allowRepeats else { return true }
            return abs(other.time.timeIntervalSince(time)) < rule.minInterval
        }
    }
}

/// Reads a start list: one runner per line, bib number first, then the name.
/// Commas, semicolons, tabs or spaces may separate the columns; lines that do
/// not start with a number (such as a header) are skipped.
enum RosterParser {
    static func parse(_ text: String) -> [RosterEntry] {
        var seen = Set<String>()
        var entries: [RosterEntry] = []
        for line in text.split(whereSeparator: { $0.isNewline }) {
            let columns = splitColumns(line.trimmingCharacters(in: .whitespaces))
            guard let first = columns.first, let bib = BibFilter.canonical(first) else { continue }
            guard seen.insert(bib).inserted else { continue }
            let name = columns.dropFirst().filter { !$0.isEmpty }.joined(separator: " ")
            entries.append(RosterEntry(bib: bib, name: name))
        }
        return entries
    }

    private static func splitColumns(_ line: String) -> [String] {
        let separators: [Character] = ["\t", ",", ";"]
        let parts: [Substring]
        if let separator = separators.first(where: { line.contains($0) }) {
            parts = line.split(separator: separator, omittingEmptySubsequences: false)
        } else {
            parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        }
        return parts.map(clean)
    }

    private static func clean(_ field: Substring) -> String {
        field.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")).trimmingCharacters(in: .whitespaces)
    }
}

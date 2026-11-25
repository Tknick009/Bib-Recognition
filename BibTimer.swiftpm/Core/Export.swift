import Foundation

/// Text formatting for times. Everything is derived from whole milliseconds
/// with integer arithmetic, so the same instant always prints the same way.
enum TimeFormat {
    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// `2026-11-25T18:04:05.123Z`
    static func isoUTC(_ date: Date) -> String {
        let (days, millisecondsOfDay) = floorDivide(milliseconds(date), 86_400_000)
        return dateText(daysSinceEpoch: days) + "T" + clockText(millisecondsOfDay, decimals: 3) + "Z"
    }

    /// `18:04:05.123` in the given time zone.
    static func timeOfDay(_ date: Date, timeZone: TimeZone, decimals: Int = 3) -> String {
        let local = milliseconds(date) + Int64(timeZone.secondsFromGMT(for: date)) * 1000
        return clockText(floorDivide(local, 86_400_000).remainder, decimals: decimals)
    }

    /// `2026-11-25` in the given time zone.
    static func localDate(_ date: Date, timeZone: TimeZone) -> String {
        let local = milliseconds(date) + Int64(timeZone.secondsFromGMT(for: date)) * 1000
        return dateText(daysSinceEpoch: floorDivide(local, 86_400_000).quotient)
    }

    /// `1:23:45.678` for a duration; negative durations get a leading minus.
    static func elapsed(milliseconds total: Int64, decimals: Int = 3) -> String {
        let magnitude = total < 0 ? -total : total
        let hours = magnitude / 3_600_000
        let minutes = magnitude / 60_000 % 60
        let seconds = magnitude / 1000 % 60
        return (total < 0 ? "-" : "") + String(hours) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2)
            + fractionText(magnitude % 1000, decimals: decimals)
    }

    static func elapsed(from start: Date, to end: Date, decimals: Int = 3) -> String {
        elapsed(milliseconds: milliseconds(end) - milliseconds(start), decimals: decimals)
    }

    /// Reads a time of day such as `9:30`, `09:30:15` or `9:30:15.25` as
    /// seconds since midnight.
    static func parseTimeOfDay(_ text: String) -> Double? {
        let parts = text.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3,
              let hours = Int(parts[0]), let minutes = Int(parts[1]),
              (0..<24).contains(hours), (0..<60).contains(minutes) else { return nil }
        var seconds = 0.0
        if parts.count == 3 {
            guard let value = Double(parts[2]), value >= 0, value < 60 else { return nil }
            seconds = value
        }
        return Double(hours * 3600 + minutes * 60) + seconds
    }

    /// The moment on `day` at which a clock shows the given time of day
    /// (seconds since midnight). Not the same as "midnight plus that many
    /// seconds" on the days the clocks go forward or back.
    static func moment(on day: Date, secondsIntoDay: Double, calendar: Calendar) -> Date? {
        guard secondsIntoDay >= 0, secondsIntoDay < 86_400 else { return nil }
        let whole = Int(secondsIntoDay)
        let date = calendar.date(bySettingHour: whole / 3600, minute: whole % 3600 / 60, second: whole % 60, of: day)
        return date?.addingTimeInterval(secondsIntoDay - Double(whole))
    }

    /// Year, month and day for a count of days since 1970-01-01.
    static func civilDate(daysSinceEpoch days: Int64) -> (year: Int, month: Int, day: Int) {
        // Days are counted from 0000-03-01 so that leap days fall at the end
        // of each (shifted) year, in 400-year cycles of 146097 days.
        let shifted = days + 719_468
        let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let shiftedMonth = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * shiftedMonth + 2) / 5 + 1
        let month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        return (Int(year), Int(month), Int(day))
    }

    private static func dateText(daysSinceEpoch days: Int64) -> String {
        let date = civilDate(daysSinceEpoch: days)
        return pad(Int64(date.year), 4) + "-" + pad(Int64(date.month), 2) + "-" + pad(Int64(date.day), 2)
    }

    private static func clockText(_ millisecondsOfDay: Int64, decimals: Int) -> String {
        let hours = millisecondsOfDay / 3_600_000
        let minutes = millisecondsOfDay / 60_000 % 60
        let seconds = millisecondsOfDay / 1000 % 60
        return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2)
            + fractionText(millisecondsOfDay % 1000, decimals: decimals)
    }

    /// The fractional part, truncated (never rounded up) to the wanted digits.
    private static func fractionText(_ milliseconds: Int64, decimals: Int) -> String {
        switch decimals {
        case ...0: return ""
        case 1: return "." + String(milliseconds / 100)
        case 2: return "." + pad(milliseconds / 10, 2)
        default: return "." + pad(milliseconds, 3)
        }
    }

    private static func pad(_ value: Int64, _ width: Int) -> String {
        let text = String(value)
        guard text.count < width else { return text }
        return String(repeating: "0", count: width - text.count) + text
    }

    private static func floorDivide(_ value: Int64, _ divisor: Int64) -> (quotient: Int64, remainder: Int64) {
        var quotient = value / divisor
        var remainder = value % divisor
        if remainder < 0 {
            quotient -= 1
            remainder += divisor
        }
        return (quotient, remainder)
    }
}

enum ExportFormat: String, CaseIterable, Identifiable {
    /// Bib and time only.
    case simple
    /// Everything that is known about each crossing.
    case detailed

    var id: String { rawValue }
}

enum CSVExport {
    static let simpleHeader = ["bib", "time_of_day", "elapsed"]
    static let detailedHeader = [
        "position", "bib", "name", "time_of_day", "elapsed", "utc", "timing", "source",
        "confidence", "sightings", "clock", "clock_error_ms", "detected_bib", "station", "note",
    ]

    /// The race's crossings in finishing order as CSV text.
    ///
    /// `time_of_day` is in the given time zone; `elapsed` is measured from the
    /// race's start time and left empty when no start time is set.
    static func csv(for race: Race, station: String, format: ExportFormat, timeZone: TimeZone) -> String {
        let names = race.rosterNames
        var rows: [[String]] = [format == .simple ? simpleHeader : detailedHeader]
        for (index, crossing) in race.sortedCrossings.enumerated() {
            let timeOfDay = TimeFormat.timeOfDay(crossing.time, timeZone: timeZone)
            let elapsed = race.startTime.map { TimeFormat.elapsed(from: $0, to: crossing.time) } ?? ""
            switch format {
            case .simple:
                rows.append([crossing.bib, timeOfDay, elapsed])
            case .detailed:
                rows.append([
                    String(index + 1),
                    crossing.bib,
                    safeText(names[crossing.bib] ?? ""),
                    timeOfDay,
                    elapsed,
                    TimeFormat.isoUTC(crossing.time),
                    crossing.timing.rawValue,
                    crossing.source.rawValue,
                    crossing.confidence.map { String(format: "%.2f", $0) } ?? "",
                    crossing.sightings.map { String($0) } ?? "",
                    crossing.clock.source.rawValue,
                    crossing.clock.uncertainty.map { String(Int(($0 * 1000).rounded())) } ?? "",
                    crossing.detectedBib ?? "",
                    safeText(station),
                    safeText(crossing.note),
                ])
            }
        }
        return rows.map { $0.map(escape).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
    }

    /// A file name for the export, e.g. `Spring-5K_Finish_2026-11-25.csv`.
    static func fileName(for race: Race, station: String, timeZone: TimeZone) -> String {
        let parts = [race.name, station, TimeFormat.localDate(race.createdAt, timeZone: timeZone)]
        let cleaned = parts.map(fileSafe).filter { !$0.isEmpty }
        return (cleaned.isEmpty ? "race" : cleaned.joined(separator: "_")) + ".csv"
    }

    /// Quotes a field when it contains a comma, a quote or a line break.
    static func escape(_ field: String) -> String {
        guard field.contains(where: { $0 == "," || $0 == "\"" || $0.isNewline }) else { return field }
        return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    /// Stops free text from being run as a formula when the file is opened
    /// in a spreadsheet.
    private static func safeText(_ text: String) -> String {
        guard let first = text.first, "=+-@\t".contains(first) else { return text }
        return "'" + text
    }

    private static func fileSafe(_ text: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        let mapped = text.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        var result = ""
        for character in mapped where !(character == "-" && result.last == "-") {
            result.append(character)
        }
        return result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

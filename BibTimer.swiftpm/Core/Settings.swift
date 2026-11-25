import Foundation

/// Everything the operator can adjust. Saved on the device and shared by all
/// races, because it describes how this iPad is set up rather than one event.
struct AppSettings: Codable, Equatable {
    /// Name of this timing point, written into every export so files from
    /// several iPads can be told apart.
    var station = "Finish"
    /// NTP servers, as host names or `host:port`.
    var ntpServers = AppSettings.defaultServers
    var rules = BibRules()
    var timingMode = TimingMode.line
    var line = FinishLine.standard
    /// The part of the frame that is searched for bibs.
    var scanZone = NormRect.full
    var minSightings = 2
    var repeatRule = RepeatRule()
    /// Capture in 4K instead of 1080p: reads bibs from further away, but slower.
    var highResolution = false
    /// Longest exposure the camera may use, as 1/x of a second; 0 leaves it
    /// automatic. Short exposures keep moving bibs sharp.
    var shutterLimit = 250
    /// Most frames per second to analyze; 0 means as many as possible.
    var maxScanRate = 10.0
    var zoom = 1.0
    /// Keep a small photo of every recorded bib for checking afterwards.
    var savePhotos = true
    /// Outline text that was read but rejected, to help with setting up.
    var showAllText = false

    static let defaultServers = ["time.apple.com", "time.cloudflare.com", "pool.ntp.org"]
    static let shutterChoices = [0, 125, 250, 500, 1000]
    static let scanRateChoices = [5.0, 10.0, 15.0, 0.0]

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = AppSettings()
        station = container.value(.station, default: defaults.station)
        ntpServers = container.value(.ntpServers, default: defaults.ntpServers)
        rules = container.value(.rules, default: defaults.rules)
        timingMode = container.value(.timingMode, default: defaults.timingMode)
        line = container.value(.line, default: defaults.line)
        scanZone = container.value(.scanZone, default: defaults.scanZone)
        minSightings = container.value(.minSightings, default: defaults.minSightings)
        repeatRule = container.value(.repeatRule, default: defaults.repeatRule)
        highResolution = container.value(.highResolution, default: defaults.highResolution)
        shutterLimit = container.value(.shutterLimit, default: defaults.shutterLimit)
        maxScanRate = container.value(.maxScanRate, default: defaults.maxScanRate)
        zoom = container.value(.zoom, default: defaults.zoom)
        savePhotos = container.value(.savePhotos, default: defaults.savePhotos)
        showAllText = container.value(.showAllText, default: defaults.showAllText)
    }

    var trackerConfig: TrackerConfig {
        TrackerConfig(mode: timingMode, line: line, minSightings: max(minSightings, 1))
    }

    /// The scan zone, or the whole frame if the saved zone is too small to use.
    var effectiveScanZone: NormRect {
        let zone = scanZone.clamped()
        return zone.width >= 0.1 && zone.height >= 0.1 ? zone : .full
    }

    /// The server list with blanks and duplicates removed.
    var cleanedServers: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for server in ntpServers {
            let name = server.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !name.isEmpty, seen.insert(name).inserted {
                result.append(name)
            }
        }
        return result
    }

    /// Splits `host` or `host:port` into its parts. The NTP port is 123.
    static func hostAndPort(_ server: String) -> (host: String, port: UInt16) {
        let parts = server.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count == 2, let port = UInt16(parts[1]), !parts[0].isEmpty {
            return (String(parts[0]), port)
        }
        return (server, 123)
    }
}

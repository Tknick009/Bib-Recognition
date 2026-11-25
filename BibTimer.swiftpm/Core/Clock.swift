import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// A clock that only ever moves forward at a steady rate.
///
/// Race times are measured on this clock and converted to time of day with a
/// `ClockFix`, so nothing that happens to the device's wall clock during a race
/// (automatic adjustments, a time-zone change, someone setting the time) can
/// move a result.
protocol MonotonicClock {
    /// Seconds since an arbitrary fixed point.
    func now() -> TimeInterval
}

/// The system's raw monotonic clock. On Apple devices it keeps counting while
/// the device is asleep and restarts only when the device reboots.
struct SystemMonotonicClock: MonotonicClock {
    func now() -> TimeInterval {
        var time = timespec()
        _ = clock_gettime(CLOCK_MONOTONIC_RAW, &time)
        return TimeInterval(time.tv_sec) + TimeInterval(time.tv_nsec) / 1_000_000_000
    }
}

enum ClockSource: String, Codable {
    /// Time of day came from an NTP time server.
    case ntp
    /// No NTP fix was available; the device's own clock was used.
    case device
}

/// How the time of a result was obtained.
struct ClockStamp: Codable, Equatable {
    var source: ClockSource
    /// Estimated worst-case error of the clock when the time was taken, in
    /// seconds. Only known for NTP time.
    var uncertainty: Double?
    /// The raw monotonic timestamp of the result and the device's boot
    /// reference (wall clock minus monotonic clock) when it was taken. Kept so
    /// the time can be worked out again from a later, better NTP fix.
    var mono: Double?
    var bootRef: Double?
}

/// The result of an NTP synchronization: the relationship between the
/// monotonic clock and UTC.
struct ClockFix: Codable, Equatable {
    /// Add this to a monotonic timestamp to get seconds since 1970 (UTC).
    var utcMinusMono: Double
    /// Worst-case error of the fix when it was taken, in seconds.
    var uncertainty: Double
    /// Monotonic time at which the fix was taken.
    var monoTime: Double
    /// What the device's own clock said (seconds since 1970) at that moment.
    var wallTime: Double
    var server: String
    var stratum: Int
    /// Network round trip of the winning sample, in seconds.
    var delay: Double
    /// How many of the servers that answered agreed with this fix.
    var agreeing: Int
    var responding: Int

    /// Assumed worst-case drift of the device's oscillator between fixes.
    static let assumedDriftPPM = 20.0

    func unixTime(atMono mono: Double) -> Double {
        mono + utcMinusMono
    }

    func date(atMono mono: Double) -> Date {
        Date(timeIntervalSince1970: unixTime(atMono: mono))
    }

    /// The fix's error bound at another moment: it grows as the fix ages.
    func uncertainty(atMono mono: Double) -> Double {
        uncertainty + abs(mono - monoTime) * ClockFix.assumedDriftPPM / 1_000_000
    }

    /// How far the device's own clock was from NTP time when the fix was taken.
    /// Positive means the device clock was ahead.
    var deviceClockError: Double {
        wallTime - unixTime(atMono: monoTime)
    }

    /// The device's boot time as its wall clock saw it when the fix was taken.
    var bootRef: Double {
        wallTime - monoTime
    }

    /// False when the monotonic clock has restarted since the fix was taken
    /// (the device rebooted), which makes the fix meaningless.
    func isUsable(nowMono: Double, nowWall: Double) -> Bool {
        guard nowMono >= monoTime else { return false }
        return abs((nowWall - nowMono) - bootRef) < ClockFix.bootTolerance
    }

    /// Whether a new fix should take over from this one.
    func shouldBeReplaced(by new: ClockFix, nowMono: Double) -> Bool {
        let aged = uncertainty(atMono: nowMono)
        if new.uncertainty <= aged { return true }
        // The new fix is less precise. Keep the old one unless the two
        // disagree by more than their error bounds allow, in which case the
        // fresh measurement wins.
        let disagreement = abs(unixTime(atMono: new.monoTime) - new.unixTime(atMono: new.monoTime))
        return disagreement > aged + new.uncertainty
    }

    /// Two boot references closer than this are taken to be the same boot. A
    /// reboot always moves the reference by much more.
    static let bootTolerance = 5.0
}

/// Converts monotonic timestamps to time of day. Safe to use from any thread.
final class RaceClock: @unchecked Sendable {
    let monotonic: MonotonicClock
    private let wall: () -> Double
    private let lock = NSLock()
    private var fix: ClockFix?

    init(monotonic: MonotonicClock = SystemMonotonicClock(),
         wall: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
        self.monotonic = monotonic
        self.wall = wall
    }

    var currentFix: ClockFix? {
        lock.lock()
        defer { lock.unlock() }
        return fix
    }

    func setFix(_ newFix: ClockFix?) {
        lock.lock()
        fix = newFix
        lock.unlock()
    }

    func monoNow() -> Double {
        monotonic.now()
    }

    func wallNow() -> Double {
        wall()
    }

    /// The device's boot reference right now: wall clock minus monotonic clock.
    func bootRefNow() -> Double {
        wall() - monotonic.now()
    }

    /// Time of day for a monotonic timestamp, with a record of where it came from.
    func stamp(mono: Double) -> (date: Date, clock: ClockStamp) {
        let bootRef = bootRefNow()
        if let fix = currentFix {
            let stamp = ClockStamp(source: .ntp, uncertainty: fix.uncertainty(atMono: mono), mono: mono, bootRef: bootRef)
            return (fix.date(atMono: mono), stamp)
        }
        let stamp = ClockStamp(source: .device, uncertainty: nil, mono: mono, bootRef: bootRef)
        return (Date(timeIntervalSince1970: mono + bootRef), stamp)
    }

    func date(mono: Double) -> Date {
        stamp(mono: mono).date
    }

    func now() -> (date: Date, clock: ClockStamp) {
        stamp(mono: monotonic.now())
    }
}

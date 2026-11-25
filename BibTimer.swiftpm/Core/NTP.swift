import Foundation

/// A 64-bit NTP timestamp: seconds since 1900-01-01 and a binary fraction.
struct NTPTimestamp: Equatable {
    var seconds: UInt32
    var fraction: UInt32

    static let zero = NTPTimestamp(seconds: 0, fraction: 0)

    /// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
    static let unixEpochOffset: UInt32 = 2_208_988_800

    var isZero: Bool { seconds == 0 && fraction == 0 }

    /// Seconds since 1970-01-01 UTC.
    ///
    /// The seconds field wraps in February 2036. A value that would fall
    /// before 1970 cannot be a current time, so it is read as belonging to
    /// the next era, which keeps this correct until 2106.
    var unixTime: Double {
        var whole = Double(seconds)
        if seconds < NTPTimestamp.unixEpochOffset {
            whole += 4_294_967_296
        }
        return whole - Double(NTPTimestamp.unixEpochOffset) + Double(fraction) / 4_294_967_296
    }

    init(seconds: UInt32, fraction: UInt32) {
        self.seconds = seconds
        self.fraction = fraction
    }

    init(unixTime: Double) {
        let ntp = unixTime + Double(NTPTimestamp.unixEpochOffset)
        let whole = ntp.rounded(.down)
        seconds = UInt32(truncatingIfNeeded: Int64(whole))
        fraction = UInt32(min((ntp - whole) * 4_294_967_296, 4_294_967_295))
    }

    /// A random value to send as the transmit timestamp. The server echoes it
    /// back, which ties each reply to its request without revealing the
    /// device's clock.
    static func random() -> NTPTimestamp {
        NTPTimestamp(seconds: UInt32.random(in: 1...UInt32.max), fraction: UInt32.random(in: 0...UInt32.max))
    }
}

enum NTPError: Error, Equatable {
    case shortPacket
    case notServerReply
    case serverUnsynchronized
    case kissOfDeath(String)
    case mismatchedReply
    case implausible
    case timeout
    case cancelled
}

extension NTPError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .shortPacket: return "The server sent an incomplete reply."
        case .notServerReply: return "The reply was not an NTP server response."
        case .serverUnsynchronized: return "The server's own clock is not synchronized."
        case .kissOfDeath(let code): return "The server refused the request (\(code))."
        case .mismatchedReply: return "The reply did not match the request."
        case .implausible: return "The server's reply was not plausible."
        case .timeout: return "The server did not answer in time."
        case .cancelled: return "The request was cancelled."
        }
    }
}

/// The fields of an NTP packet that a client needs.
struct NTPResponse: Equatable {
    var leap: Int
    var version: Int
    var mode: Int
    var stratum: Int
    var rootDelay: Double
    var rootDispersion: Double
    var referenceID: UInt32
    var originate: NTPTimestamp
    var receive: NTPTimestamp
    var transmit: NTPTimestamp
}

/// One completed request/response exchange with a time server.
struct NTPSample: Equatable {
    var server: String
    /// Add to a monotonic timestamp to get seconds since 1970 (UTC).
    var utcMinusMono: Double
    /// Network round trip, excluding the server's processing time.
    var delay: Double
    var rootDelay: Double
    var rootDispersion: Double
    var stratum: Int
    /// Monotonic time at which the reply arrived.
    var takenAt: Double

    /// Worst-case error of this sample: half the round trip (the reply could
    /// have spent all of it travelling in one direction) plus the server's own
    /// distance from its reference clock.
    var errorBound: Double {
        delay / 2 + rootDelay / 2 + rootDispersion
    }
}

enum NTPPacket {
    static let size = 48
    private static let clientMode = 3
    private static let serverMode = 4

    /// A client request (SNTP, protocol version 4).
    static func request(transmit: NTPTimestamp) -> Data {
        var bytes = [UInt8](repeating: 0, count: size)
        bytes[0] = 0x23 // leap 0, version 4, mode 3 (client)
        write(transmit.seconds, to: &bytes, at: 40)
        write(transmit.fraction, to: &bytes, at: 44)
        return Data(bytes)
    }

    /// A server reply. Used by the tests and by anything that needs to stand
    /// in for a time server.
    static func response(originate: NTPTimestamp,
                         receive: NTPTimestamp,
                         transmit: NTPTimestamp,
                         stratum: Int = 2,
                         leap: Int = 0,
                         mode: Int = 4,
                         rootDelay: Double = 0.004,
                         rootDispersion: Double = 0.002,
                         referenceID: UInt32 = 0x4750_5300) -> Data {
        var bytes = [UInt8](repeating: 0, count: size)
        bytes[0] = UInt8(truncatingIfNeeded: (leap & 0x3) << 6 | (4 << 3) | (mode & 0x7))
        bytes[1] = UInt8(truncatingIfNeeded: stratum)
        bytes[2] = 6
        bytes[3] = 0xEC // precision 2^-20 s
        write(UInt32(max(0, min(rootDelay * 65536, 4_294_967_295))), to: &bytes, at: 4)
        write(UInt32(max(0, min(rootDispersion * 65536, 4_294_967_295))), to: &bytes, at: 8)
        write(referenceID, to: &bytes, at: 12)
        write(receive.seconds, to: &bytes, at: 16)
        write(receive.fraction, to: &bytes, at: 20)
        write(originate.seconds, to: &bytes, at: 24)
        write(originate.fraction, to: &bytes, at: 28)
        write(receive.seconds, to: &bytes, at: 32)
        write(receive.fraction, to: &bytes, at: 36)
        write(transmit.seconds, to: &bytes, at: 40)
        write(transmit.fraction, to: &bytes, at: 44)
        return Data(bytes)
    }

    static func parse(_ data: Data) throws -> NTPResponse {
        let bytes = [UInt8](data)
        guard bytes.count >= size else { throw NTPError.shortPacket }
        return NTPResponse(
            leap: Int(bytes[0] >> 6),
            version: Int((bytes[0] >> 3) & 0x7),
            mode: Int(bytes[0] & 0x7),
            stratum: Int(bytes[1]),
            rootDelay: Double(read(bytes, at: 4)) / 65536,
            rootDispersion: Double(read(bytes, at: 8)) / 65536,
            referenceID: read(bytes, at: 12),
            originate: NTPTimestamp(seconds: read(bytes, at: 24), fraction: read(bytes, at: 28)),
            receive: NTPTimestamp(seconds: read(bytes, at: 32), fraction: read(bytes, at: 36)),
            transmit: NTPTimestamp(seconds: read(bytes, at: 40), fraction: read(bytes, at: 44))
        )
    }

    /// Validates a reply and works out the clock offset it implies.
    ///
    /// - Parameters:
    ///   - nonce: the transmit timestamp that was sent in the request.
    ///   - sent: monotonic time just before the request was sent.
    ///   - received: monotonic time when the reply arrived.
    static func sample(from data: Data, nonce: NTPTimestamp, sent: Double, received: Double, server: String) throws -> NTPSample {
        let reply = try parse(data)
        guard reply.mode == serverMode else { throw NTPError.notServerReply }
        // The reply must echo the request's timestamp. Checked before anything
        // else so that stray or late packets are simply ignored by the caller.
        guard reply.originate == nonce else { throw NTPError.mismatchedReply }
        if reply.stratum == 0 {
            throw NTPError.kissOfDeath(kissCode(reply.referenceID))
        }
        guard reply.stratum <= 15, reply.leap != 3 else { throw NTPError.serverUnsynchronized }
        guard !reply.receive.isZero, !reply.transmit.isZero else { throw NTPError.implausible }

        let serverReceive = reply.receive.unixTime
        let serverTransmit = reply.transmit.unixTime
        let processing = serverTransmit - serverReceive
        let roundTrip = received - sent
        guard processing >= 0, processing < 2, roundTrip >= 0 else { throw NTPError.implausible }
        // A server that is itself far from its reference is not worth using.
        guard reply.rootDelay / 2 + reply.rootDispersion < 1.5 else { throw NTPError.serverUnsynchronized }

        // Standard NTP on-wire calculation, with the local clock being the
        // monotonic clock rather than the wall clock.
        let offset = ((serverReceive - sent) + (serverTransmit - received)) / 2
        let delay = max(roundTrip - processing, 0)
        return NTPSample(
            server: server,
            utcMinusMono: offset,
            delay: delay,
            rootDelay: reply.rootDelay,
            rootDispersion: reply.rootDispersion,
            stratum: reply.stratum,
            takenAt: received
        )
    }

    private static func kissCode(_ referenceID: UInt32) -> String {
        var bytes: [UInt8] = []
        for shift in [24, 16, 8, 0] {
            let byte = UInt8(truncatingIfNeeded: referenceID >> UInt32(shift))
            if byte >= 0x20 && byte < 0x7F { bytes.append(byte) }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func read(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        var value: UInt32 = 0
        for index in 0..<4 {
            value = (value << 8) | UInt32(bytes[offset + index])
        }
        return value
    }

    private static func write(_ value: UInt32, to bytes: inout [UInt8], at offset: Int) {
        for index in 0..<4 {
            bytes[offset + index] = UInt8(truncatingIfNeeded: value >> UInt32(8 * (3 - index)))
        }
    }
}

/// Picks the time to trust from a set of samples.
enum NTPSelection {
    struct Choice: Equatable {
        var sample: NTPSample
        /// Servers whose answers are consistent with the chosen one.
        var agreeing: Int
        var responding: Int
    }

    /// The best of several samples from one server: the one with the shortest
    /// round trip, because its error is the most tightly bounded.
    static func best(of samples: [NTPSample]) -> NTPSample? {
        samples.min { $0.delay < $1.delay }
    }

    /// Chooses among the best samples of several servers.
    ///
    /// Every sample claims the true offset lies within its error bound. The
    /// offset range that the largest number of servers agree on is found
    /// (Marzullo's algorithm), servers outside it are discarded as wrong, and
    /// the most precise of the remaining samples is returned.
    static func select(_ candidates: [NTPSample]) -> Choice? {
        guard !candidates.isEmpty else { return nil }
        let margin = 0.005

        var edges: [(value: Double, isStart: Bool)] = []
        for candidate in candidates {
            let reach = candidate.errorBound + margin
            edges.append((candidate.utcMinusMono - reach, true))
            edges.append((candidate.utcMinusMono + reach, false))
        }
        edges.sort { lhs, rhs in
            if lhs.value != rhs.value { return lhs.value < rhs.value }
            return lhs.isStart && !rhs.isStart
        }

        var overlap = 0
        var bestOverlap = 0
        var low = 0.0
        var high = 0.0
        for (index, edge) in edges.enumerated() {
            if edge.isStart {
                overlap += 1
                if overlap > bestOverlap, index + 1 < edges.count {
                    bestOverlap = overlap
                    low = edge.value
                    high = edges[index + 1].value
                }
            } else {
                overlap -= 1
            }
        }

        let middle = (low + high) / 2
        let agreeing = candidates.filter { abs($0.utcMinusMono - middle) <= $0.errorBound + margin }
        guard let chosen = agreeing.min(by: { $0.errorBound < $1.errorBound }) else { return nil }
        return Choice(sample: chosen, agreeing: agreeing.count, responding: candidates.count)
    }
}

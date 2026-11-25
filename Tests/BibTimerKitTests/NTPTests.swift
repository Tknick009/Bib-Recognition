import XCTest
@testable import BibTimerKit

final class NTPTests: XCTestCase {
    func testRequestIsAVersion4ClientPacket() {
        let nonce = NTPTimestamp(seconds: 0x0102_0304, fraction: 0x0A0B_0C0D)
        let bytes = [UInt8](NTPPacket.request(transmit: nonce))
        XCTAssertEqual(bytes.count, 48)
        XCTAssertEqual(bytes[0], 0x23)
        XCTAssertEqual(Array(bytes[1..<40]), [UInt8](repeating: 0, count: 39))
        XCTAssertEqual(Array(bytes[40..<48]), [1, 2, 3, 4, 10, 11, 12, 13])
    }

    func testTimestampConversion() {
        // 2021-01-01T00:00:00Z is 1 609 459 200 in Unix time.
        let stamp = NTPTimestamp(seconds: 3_818_448_000, fraction: 0x8000_0000)
        XCTAssertEqual(stamp.unixTime, 1_609_459_200.5, accuracy: 1e-6)

        let back = NTPTimestamp(unixTime: 1_609_459_200.5)
        XCTAssertEqual(back.seconds, 3_818_448_000)
        // Within a microsecond (one second is 2^32 fraction units).
        XCTAssertEqual(Double(back.fraction), Double(0x8000_0000 as UInt32), accuracy: 4300)
        XCTAssertTrue(NTPTimestamp.zero.isZero)
        XCTAssertFalse(stamp.isZero)
    }

    func testTimestampAfterThe2036Rollover() {
        // 2040-01-01T00:00:00Z. Its NTP seconds value no longer fits in 32
        // bits and wraps around to 123 010 304.
        let stamp = NTPTimestamp(seconds: 123_010_304, fraction: 0)
        XCTAssertEqual(stamp.unixTime, 2_208_988_800, accuracy: 1e-6)
        XCTAssertEqual(NTPTimestamp(unixTime: 2_208_988_800).seconds, 123_010_304)
    }

    func testSampleRecoversTheClockOffset() throws {
        // The device's monotonic clock reads 1000 s when the true time is `trueTime`.
        let trueTime = 1_800_000_000.25
        let sent = 1000.0
        let nonce = NTPTimestamp(seconds: 77, fraction: 99)
        // 10 ms each way on the network and 1 ms inside the server.
        let reply = NTPPacket.response(
            originate: nonce,
            receive: NTPTimestamp(unixTime: trueTime + 0.010),
            transmit: NTPTimestamp(unixTime: trueTime + 0.011)
        )
        let sample = try NTPPacket.sample(from: reply, nonce: nonce, sent: sent, received: sent + 0.021, server: "test")

        XCTAssertEqual(sample.utcMinusMono, trueTime - sent, accuracy: 1e-5)
        XCTAssertEqual(sample.delay, 0.020, accuracy: 1e-5)
        XCTAssertEqual(sample.stratum, 2)
        XCTAssertEqual(sample.server, "test")
        XCTAssertEqual(sample.takenAt, sent + 0.021, accuracy: 1e-9)
        XCTAssertEqual(sample.rootDelay, 0.004, accuracy: 1e-4)
        XCTAssertEqual(sample.rootDispersion, 0.002, accuracy: 1e-4)
        XCTAssertEqual(sample.errorBound, 0.014, accuracy: 2e-4)
    }

    func testErrorFromAnAsymmetricPathStaysWithinTheBound() throws {
        let trueTime = 1_800_000_000.0
        let sent = 50.0
        let nonce = NTPTimestamp(seconds: 1, fraction: 2)
        // 80 ms to reach the server, 20 ms back.
        let serverClock = NTPTimestamp(unixTime: trueTime + 0.080)
        let reply = NTPPacket.response(originate: nonce, receive: serverClock, transmit: serverClock)
        let sample = try NTPPacket.sample(from: reply, nonce: nonce, sent: sent, received: sent + 0.100, server: "test")

        let error = abs(sample.utcMinusMono - (trueTime - sent))
        XCTAssertEqual(error, 0.030, accuracy: 1e-4)
        XCTAssertLessThanOrEqual(error, sample.errorBound)
    }

    func testRejectsRepliesThatCannotBeTrusted() {
        let nonce = NTPTimestamp(seconds: 5, fraction: 6)
        let good = NTPTimestamp(unixTime: 1_800_000_000)

        func failure(_ data: Data) -> NTPError? {
            do {
                _ = try NTPPacket.sample(from: data, nonce: nonce, sent: 1, received: 1.02, server: "test")
                return nil
            } catch {
                return error as? NTPError
            }
        }

        XCTAssertNil(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good)))
        XCTAssertEqual(failure(Data(count: 20)), .shortPacket)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good, mode: 3)), .notServerReply)
        XCTAssertEqual(failure(NTPPacket.response(originate: NTPTimestamp(seconds: 9, fraction: 9), receive: good, transmit: good)), .mismatchedReply)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good, stratum: 0, referenceID: 0x5241_5445)), .kissOfDeath("RATE"))
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good, leap: 3)), .serverUnsynchronized)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good, stratum: 16)), .serverUnsynchronized)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: .zero, transmit: good)), .implausible)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: NTPTimestamp(unixTime: 1_799_999_990))), .implausible)
        XCTAssertEqual(failure(NTPPacket.response(originate: nonce, receive: good, transmit: good, rootDispersion: 3)), .serverUnsynchronized)
    }

    // MARK: Selection

    private func sample(_ server: String, offset: Double, delay: Double) -> NTPSample {
        NTPSample(server: server, utcMinusMono: offset, delay: delay, rootDelay: 0.004, rootDispersion: 0.002, stratum: 2, takenAt: 10)
    }

    func testBestSampleHasTheShortestRoundTrip() {
        let samples = [
            sample("a", offset: 100.004, delay: 0.060),
            sample("a", offset: 100.001, delay: 0.018),
            sample("a", offset: 100.003, delay: 0.035),
        ]
        XCTAssertEqual(NTPSelection.best(of: samples)?.delay, 0.018)
        XCTAssertNil(NTPSelection.best(of: []))
    }

    func testSelectionDiscardsAServerThatDisagrees() {
        let candidates = [
            sample("good1", offset: 100.000, delay: 0.020),
            sample("wrong", offset: 103.500, delay: 0.004),
            sample("good2", offset: 100.006, delay: 0.040),
        ]
        let choice = NTPSelection.select(candidates)
        XCTAssertEqual(choice?.sample.server, "good1")
        XCTAssertEqual(choice?.agreeing, 2)
        XCTAssertEqual(choice?.responding, 3)
    }

    func testSelectionPrefersTheMostPreciseOfAgreeingServers() {
        let candidates = [
            sample("slow", offset: 100.010, delay: 0.200),
            sample("fast", offset: 100.000, delay: 0.010),
            sample("medium", offset: 100.004, delay: 0.060),
        ]
        let choice = NTPSelection.select(candidates)
        XCTAssertEqual(choice?.sample.server, "fast")
        XCTAssertEqual(choice?.agreeing, 3)
    }

    func testSelectionWithOneServerAndWithNone() {
        XCTAssertNil(NTPSelection.select([]))
        let only = sample("solo", offset: 5, delay: 0.03)
        XCTAssertEqual(NTPSelection.select([only]), NTPSelection.Choice(sample: only, agreeing: 1, responding: 1))
    }
}

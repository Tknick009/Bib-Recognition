#if canImport(Network)
import XCTest
import Network
@testable import BibTimerKit

/// Exercises the real UDP client, first against a small time server running
/// inside the test and then, when the network allows it, against a public one.
final class NTPClientTests: XCTestCase {
    /// A UDP server that answers NTP requests with the time of a clock that is
    /// `skew` seconds ahead of this machine's.
    private final class LocalTimeServer {
        let skew: Double
        private let listener: NWListener
        private let queue = DispatchQueue(label: "test.ntp.server")

        init(skew: Double) throws {
            self.skew = skew
            listener = try NWListener(using: .udp, on: .any)
        }

        /// Starts listening and returns the port, or nil if the listener
        /// could not start in this environment.
        func start() async -> UInt16? {
            listener.newConnectionHandler = { [skew, queue] connection in
                connection.start(queue: queue)
                LocalTimeServer.serve(connection, skew: skew)
            }
            let resumed = Flag()
            let ready: Bool = await withCheckedContinuation { continuation in
                listener.stateUpdateHandler = { state in
                    guard !resumed.isSet else { return }
                    switch state {
                    case .ready:
                        resumed.isSet = true
                        continuation.resume(returning: true)
                    case .failed, .cancelled:
                        resumed.isSet = true
                        continuation.resume(returning: false)
                    default:
                        break
                    }
                }
                listener.start(queue: queue)
            }
            return ready ? listener.port?.rawValue : nil
        }

        /// Set from the listener's queue only.
        private final class Flag {
            var isSet = false
        }

        func stop() {
            listener.cancel()
        }

        private static func serve(_ connection: NWConnection, skew: Double) {
            connection.receiveMessage { data, _, _, error in
                if let data, let request = try? NTPPacket.parse(data) {
                    let now = NTPTimestamp(unixTime: Date().timeIntervalSince1970 + skew)
                    let reply = NTPPacket.response(originate: request.transmit, receive: now, transmit: now)
                    connection.send(content: reply, completion: .contentProcessed { _ in })
                }
                if error == nil {
                    serve(connection, skew: skew)
                }
            }
        }
    }

    func testClientMeasuresTheOffsetOfALocalServer() async throws {
        let server = try LocalTimeServer(skew: 1234.5)
        guard let port = await server.start() else {
            throw XCTSkip("could not start a local UDP listener")
        }
        defer { server.stop() }

        let clock = SystemMonotonicClock()
        let configuration = NTPClient.Configuration(samples: 3, spacing: 0.05, timeout: 2)
        let result = await NTPClient.samples(host: "127.0.0.1", port: port, clock: clock, configuration: configuration)
        let samples = try result.get()

        XCTAssertEqual(samples.count, 3)
        let best = try XCTUnwrap(NTPSelection.best(of: samples))
        let expected = Date().timeIntervalSince1970 + 1234.5 - clock.now()
        XCTAssertEqual(best.utcMinusMono, expected, accuracy: 0.05)
        XCTAssertLessThan(best.delay, 0.5)
        XCTAssertEqual(best.server, "127.0.0.1")
    }

    func testClientReportsAServerThatDoesNotAnswer() async throws {
        // Nothing listens on this port, so every request goes unanswered.
        let configuration = NTPClient.Configuration(samples: 2, spacing: 0.05, timeout: 0.4)
        let started = Date()
        let result = await NTPClient.samples(host: "127.0.0.1", port: 9, clock: SystemMonotonicClock(), configuration: configuration)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        if case .success(let samples) = result {
            XCTFail("unexpected answer: \(samples)")
        }
    }

    func testPublicServerWhenReachable() async throws {
        let clock = SystemMonotonicClock()
        let configuration = NTPClient.Configuration(samples: 3, spacing: 0.3, timeout: 3)
        let result = await NTPClient.samples(host: "time.apple.com", clock: clock, configuration: configuration)
        guard case .success(let samples) = result, let best = NTPSelection.best(of: samples) else {
            throw XCTSkip("no answer from time.apple.com (\(result)); skipping the live check")
        }

        // This machine's clock is itself kept on time, so the two should
        // agree to well within a few seconds.
        let ntpNow = best.utcMinusMono + clock.now()
        let deviceError = Date().timeIntervalSince1970 - ntpNow
        print("Live NTP check: \(samples.count) samples, stratum \(best.stratum), round trip \(best.delay) s, " +
              "error bound \(best.errorBound) s, this machine's clock is off by \(deviceError) s")
        XCTAssertLessThan(abs(deviceError), 5)
        XCTAssertLessThan(best.delay, 3)
        XCTAssertTrue((1...15).contains(best.stratum))
    }
}
#endif

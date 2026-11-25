import XCTest
@testable import BibTimerKit
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

#if canImport(Darwin) || canImport(Glibc)
/// Checks the NTP packet code against real time servers.
///
/// Plain sockets are used on purpose: the check then does not depend on the
/// app's own network client, and it runs on Linux as well. Where the network
/// does not let NTP through, the test is skipped.
final class LiveNTPTests: XCTestCase {
    private static let servers = ["time.apple.com", "time.cloudflare.com", "pool.ntp.org", "time.google.com"]

    private struct Exchange {
        var reply: Data
        var sent: Double
        var received: Double
    }

    /// Sends one request to UDP port 123 of `host` and waits for the reply.
    private func exchange(with host: String, request: Data, clock: MonotonicClock) -> Exchange? {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        #if canImport(Glibc)
        hints.ai_socktype = Int32(SOCK_DGRAM.rawValue)
        #else
        hints.ai_socktype = SOCK_DGRAM
        #endif

        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, "123", &hints, &list) == 0, let first = list else { return nil }
        defer { freeaddrinfo(first) }

        var next: UnsafeMutablePointer<addrinfo>? = first
        while let info = next {
            next = info.pointee.ai_next
            if let result = exchange(on: info.pointee, request: request, clock: clock) {
                return result
            }
        }
        return nil
    }

    private func exchange(on address: addrinfo, request: Data, clock: MonotonicClock) -> Exchange? {
        let descriptor = socket(address.ai_family, address.ai_socktype, address.ai_protocol)
        guard descriptor >= 0 else { return nil }
        defer { _ = close(descriptor) }

        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        let bytes = [UInt8](request)
        let sent = clock.now()
        let sentCount = sendto(descriptor, bytes, bytes.count, 0, address.ai_addr, address.ai_addrlen)
        guard sentCount == bytes.count else { return nil }

        var buffer = [UInt8](repeating: 0, count: 512)
        let capacity = buffer.count
        let count = recv(descriptor, &buffer, capacity, 0)
        let received = clock.now()
        guard count >= NTPPacket.size else { return nil }
        return Exchange(reply: Data(buffer[0..<count]), sent: sent, received: received)
    }

    func testPacketCodeAgainstRealServers() throws {
        let clock = SystemMonotonicClock()
        var answered = 0
        for host in LiveNTPTests.servers {
            let nonce = NTPTimestamp.random()
            guard let result = exchange(with: host, request: NTPPacket.request(transmit: nonce), clock: clock) else {
                print("Live NTP packet check: no reply from \(host)")
                continue
            }
            let sample: NTPSample
            do {
                sample = try NTPPacket.sample(from: result.reply, nonce: nonce, sent: result.sent, received: result.received, server: host)
            } catch NTPError.kissOfDeath(let code) {
                print("Live NTP packet check: \(host) declined (\(code))")
                continue
            }
            answered += 1

            // This machine's clock is kept on time, so NTP time worked out
            // from the reply must agree with it closely.
            let deviceError = Date().timeIntervalSince1970 - (sample.utcMinusMono + clock.now())
            print("Live NTP packet check: \(host) stratum \(sample.stratum), round trip \(sample.delay) s, " +
                  "error bound \(sample.errorBound) s; this machine's clock is off by \(deviceError) s")
            XCTAssertLessThan(abs(deviceError), 5, host)
            XCTAssertLessThan(sample.delay, 3, host)
            XCTAssertTrue((1...15).contains(sample.stratum), host)
        }
        if answered == 0 {
            throw XCTSkip("no time server could be reached over UDP port 123 from this machine")
        }
    }
}
#endif

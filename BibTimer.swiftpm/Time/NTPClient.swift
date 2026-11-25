#if canImport(Network)
import Foundation
import Network

/// Asks one time server for the time, several times in a row, over UDP.
///
/// Every exchange is timed on the monotonic clock just before the request
/// leaves and as soon as the reply arrives; `NTPPacket.sample` turns those two
/// readings and the server's timestamps into a clock offset.
final class NTPClient {
    struct Configuration {
        /// Requests to send. The best reply is used, so more is better up to
        /// a point; servers dislike being hammered.
        var samples = 4
        /// Pause between requests, in seconds.
        var spacing: TimeInterval = 0.25
        /// How long to wait for each reply, in seconds.
        var timeout: TimeInterval = 1.5
    }

    private let host: String
    private let port: UInt16
    private let clock: MonotonicClock
    private let configuration: Configuration
    private let queue = DispatchQueue(label: "bibtimer.ntp")

    // Everything below is only touched on `queue`.
    private var connection: NWConnection?
    private var completion: ((Result<[NTPSample], Error>) -> Void)?
    private var samples: [NTPSample] = []
    private var lastError: Error?
    private var remaining = 0
    private var failuresInARow = 0
    private var pending: (nonce: NTPTimestamp, sent: Double)?
    private var timeoutWork: DispatchWorkItem?
    private var started = false
    private var finished = false

    init(host: String, port: UInt16 = 123, clock: MonotonicClock, configuration: Configuration = Configuration()) {
        self.host = host
        self.port = port
        self.clock = clock
        self.configuration = configuration
    }

    /// Collects samples from a server. Fails only if not a single request was
    /// answered.
    static func samples(host: String,
                        port: UInt16 = 123,
                        clock: MonotonicClock,
                        configuration: Configuration = Configuration()) async -> Result<[NTPSample], Error> {
        let client = NTPClient(host: host, port: port, clock: clock, configuration: configuration)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                client.run { result in
                    continuation.resume(returning: result)
                }
            }
        } onCancel: {
            client.cancel()
        }
    }

    /// Starts the exchange. `completion` is called exactly once, on a
    /// background queue.
    func run(completion: @escaping (Result<[NTPSample], Error>) -> Void) {
        queue.async {
            self.completion = completion
            self.remaining = max(self.configuration.samples, 1)
            guard !self.host.isEmpty, let port = NWEndpoint.Port(rawValue: self.port) else {
                self.fail(NTPError.implausible)
                return
            }
            let connection = NWConnection(host: NWEndpoint.Host(self.host), port: port, using: .udp)
            self.connection = connection
            connection.stateUpdateHandler = { state in
                self.handle(state)
            }
            connection.start(queue: self.queue)
            // Covers a connection that never becomes ready (no route, DNS
            // not answering).
            self.armTimeout(after: self.configuration.timeout + 1) {
                self.fail(NTPError.timeout)
            }
        }
    }

    func cancel() {
        queue.async {
            self.fail(NTPError.cancelled)
        }
    }

    private func handle(_ state: NWConnection.State) {
        guard !finished else { return }
        switch state {
        case .ready:
            guard !started else { return }
            started = true
            receiveNext()
            sendNext()
        case .waiting(let error):
            // No usable network path at the moment. Report it rather than
            // wait; the caller retries on its own schedule.
            fail(error)
        case .failed(let error):
            fail(error)
        default:
            break
        }
    }

    private func sendNext() {
        guard !finished else { return }
        guard remaining > 0, let connection else {
            finish()
            return
        }
        remaining -= 1
        let nonce = NTPTimestamp.random()
        let request = NTPPacket.request(transmit: nonce)
        pending = (nonce, clock.now())
        connection.send(content: request, completion: .contentProcessed { error in
            if let error {
                self.sampleFailed(error)
            }
        })
        armTimeout(after: configuration.timeout) {
            self.sampleFailed(NTPError.timeout)
        }
    }

    private func receiveNext() {
        guard !finished, let connection else { return }
        connection.receiveMessage { data, _, _, error in
            // Taken first: this is the moment the reply arrived.
            let received = self.clock.now()
            guard !self.finished else { return }
            if let data, let pending = self.pending {
                do {
                    let sample = try NTPPacket.sample(from: data, nonce: pending.nonce, sent: pending.sent,
                                                      received: received, server: self.host)
                    self.sampleSucceeded(sample)
                } catch NTPError.mismatchedReply {
                    // A late answer to an earlier request. Keep waiting.
                } catch NTPError.kissOfDeath(let code) {
                    // The server asked not to be queried: stop at once.
                    self.fail(NTPError.kissOfDeath(code))
                    return
                } catch {
                    self.sampleFailed(error)
                }
            }
            if let error {
                self.fail(error)
                return
            }
            self.receiveNext()
        }
    }

    private func sampleSucceeded(_ sample: NTPSample) {
        pending = nil
        timeoutWork?.cancel()
        failuresInARow = 0
        samples.append(sample)
        scheduleNext()
    }

    private func sampleFailed(_ error: Error) {
        guard !finished, pending != nil else { return }
        pending = nil
        timeoutWork?.cancel()
        lastError = error
        failuresInARow += 1
        // A server that answered and then goes quiet is limiting how often it
        // may be asked, so stop there. One that has not answered at all gets
        // one more try.
        if !samples.isEmpty || failuresInARow >= 2 {
            finish()
        } else {
            scheduleNext()
        }
    }

    private func scheduleNext() {
        guard remaining > 0 else {
            finish()
            return
        }
        queue.asyncAfter(deadline: .now() + configuration.spacing) {
            self.sendNext()
        }
    }

    private func armTimeout(after seconds: TimeInterval, _ action: @escaping () -> Void) {
        timeoutWork?.cancel()
        let work = DispatchWorkItem(block: action)
        timeoutWork = work
        queue.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func fail(_ error: Error) {
        guard !finished else { return }
        lastError = error
        finish()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        timeoutWork?.cancel()
        timeoutWork = nil
        pending = nil
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        let completion = self.completion
        self.completion = nil
        if samples.isEmpty {
            completion?(.failure(lastError ?? NTPError.timeout))
        } else {
            completion?(.success(samples))
        }
    }
}
#endif

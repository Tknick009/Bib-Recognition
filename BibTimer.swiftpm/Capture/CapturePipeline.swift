#if canImport(UIKit)
import AVFoundation
import CoreImage
import Foundation
import ImageIO

/// Everything the analysis of a frame depends on.
struct PipelineConfig: Equatable {
    var rules = BibRules()
    /// When set, only these bib numbers are accepted.
    var roster: Set<String>?
    var recognizer = RecognizerOptions()
    var tracker = TrackerConfig()
    /// Most frames to analyze per second; 0 for no limit.
    var maxScanRate = 10.0
    var savePhotos = true
    var showAllText = false
}

/// What the analysis of one frame produced.
struct FrameResult {
    /// Identifies the recording these results belong to; 0 while only
    /// previewing.
    var generation: Int
    /// Size of the (upright) frame in pixels; zero when no frame was analyzed.
    var frameWidth = 0
    var frameHeight = 0
    /// The bibs visible in the frame.
    var overlays: [TrackOverlay] = []
    /// Text that was read but is not a bib; only filled in when asked for.
    var otherText: [NormRect] = []
    /// Bibs whose time was taken, corrected or completed.
    var sightings: [BibSighting] = []
    /// How long the analysis took, in seconds.
    var duration = 0.0
}

/// Turns video frames into bib sightings: text recognition, bib rules,
/// tracking, time stamping and a photo of each recorded bib.
///
/// Not thread-safe. Every method must be called on the camera's video queue.
final class CapturePipeline {
    var resultHandler: (@Sendable (FrameResult) -> Void)?

    private let clock: RaceClock
    private let recognizer = TextRecognizer()
    private let imageContext = CIContext()
    private let photoColorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var config = PipelineConfig()
    private var tracker = BibTracker()
    private var generation = 0
    private var lastAnalyzed = -Double.infinity
    /// Photos of bibs that are being followed but have no time yet.
    private var pendingPhotos: [Int: Data] = [:]

    init(clock: RaceClock) {
        self.clock = clock
    }

    func update(_ newConfig: PipelineConfig) {
        config = newConfig
        tracker.config = newConfig.tracker
    }

    /// Starts a recording: bibs already in view are forgotten, so only what
    /// happens from now on is recorded.
    func beginRecording(generation newGeneration: Int) {
        tracker.reset()
        pendingPhotos.removeAll()
        generation = newGeneration
    }

    /// Ends the recording. Bibs still being followed get their best time.
    func endRecording() {
        let events = tracker.finish()
        var result = FrameResult(generation: generation)
        result.sightings = events.map { BibSighting(report: report(for: $0), photo: $0.isNew ? pendingPhotos[$0.trackID] : nil) }
        pendingPhotos.removeAll()
        generation = 0
        resultHandler?(result)
    }

    /// Analyzes one video frame. Frames arriving faster than the scan rate
    /// allows are skipped.
    func process(_ sampleBuffer: CMSampleBuffer, synchronizationClock: CMClock?) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let frameTime = monotonicTime(of: sampleBuffer, synchronizationClock: synchronizationClock)
        if config.maxScanRate > 0, frameTime - lastAnalyzed < 1 / config.maxScanRate - 0.004 {
            return
        }
        lastAnalyzed = frameTime

        let started = clock.monoNow()
        guard let candidates = try? recognizer.candidates(in: pixelBuffer, options: config.recognizer) else { return }
        let detections = BibFilter.detections(from: candidates, rules: config.rules, roster: config.roster)
        let output = tracker.process(time: frameTime, detections: detections)

        var result = FrameResult(generation: generation)
        result.frameWidth = CVPixelBufferGetWidth(pixelBuffer)
        result.frameHeight = CVPixelBufferGetHeight(pixelBuffer)
        result.overlays = output.overlays
        if config.showAllText {
            let accepted = Set(detections.map(\.box))
            result.otherText = candidates.map(\.box).filter { !accepted.contains($0) }
        }

        if generation != 0 {
            let takesPhotos = config.savePhotos
            // A bib that is believed but not yet timed gets its photo now, in
            // case it has left the frame by the time its time is decided.
            if takesPhotos {
                for overlay in output.overlays where overlay.state == .tracking && pendingPhotos[overlay.id] == nil {
                    pendingPhotos[overlay.id] = photo(of: pixelBuffer, around: overlay.box)
                }
            }
            let visible = Set(output.overlays.map(\.id))
            for event in output.events {
                var picture: Data?
                if event.isNew, takesPhotos {
                    // Prefer the frame in which the time was taken.
                    picture = visible.contains(event.trackID) ? photo(of: pixelBuffer, around: event.box) : nil
                    picture = picture ?? pendingPhotos[event.trackID]
                }
                if event.isNew || event.ended {
                    pendingPhotos[event.trackID] = nil
                }
                result.sightings.append(BibSighting(report: report(for: event), photo: picture))
            }
        }

        result.duration = clock.monoNow() - started
        resultHandler?(result)
    }

    // MARK: Time

    /// When the frame was captured, on the monotonic clock.
    ///
    /// Frames are stamped by the camera on the host clock. Analysis starts a
    /// little later (and takes a while), so the frame's age is subtracted from
    /// the current monotonic time rather than using "now".
    private func monotonicTime(of sampleBuffer: CMSampleBuffer, synchronizationClock: CMClock?) -> Double {
        let now = clock.monoNow()
        let hostClock = CMClockGetHostTimeClock()
        var captured = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let synchronizationClock {
            captured = CMSyncConvertTime(captured, from: synchronizationClock, to: hostClock)
        }
        let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(hostClock), captured))
        guard age.isFinite, age >= 0, age < 2 else { return now }
        return now - age
    }

    private func report(for snapshot: TrackSnapshot) -> TrackReport {
        let stamp = clock.stamp(mono: snapshot.time)
        return TrackReport(
            trackID: snapshot.trackID,
            bib: snapshot.bib,
            time: stamp.date,
            timing: snapshot.timing,
            clock: stamp.clock,
            firstSeen: clock.date(mono: snapshot.firstSeen),
            lastSeen: clock.date(mono: snapshot.lastSeen),
            sightings: snapshot.sightings,
            confidence: snapshot.confidence,
            ended: snapshot.ended
        )
    }

    // MARK: Photos

    /// A small JPEG of the runner wearing the bib: the area around the
    /// number, taller above it than below so the face is included.
    private func photo(of pixelBuffer: CVPixelBuffer, around box: NormRect) -> Data? {
        let width = Double(CVPixelBufferGetWidth(pixelBuffer))
        let height = Double(CVPixelBufferGetHeight(pixelBuffer))
        let digitHeight = max(box.height * height, 12)
        let centerX = box.midX * width
        let centerY = box.midY * height

        let left = max(centerX - 4.5 * digitHeight, 0)
        let right = min(centerX + 4.5 * digitHeight, width)
        let top = max(centerY - 9 * digitHeight, 0)
        let bottom = min(centerY + 4 * digitHeight, height)
        guard right - left >= 16, bottom - top >= 16 else { return nil }

        // Core Image measures from the bottom-left corner.
        let crop = CGRect(x: left, y: height - bottom, width: right - left, height: bottom - top)
        var image = CIImage(cvPixelBuffer: pixelBuffer).cropped(to: crop)
        let scale = min(1, 420 / max(crop.width, crop.height))
        if scale < 1 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return imageContext.jpegRepresentation(of: image, colorSpace: photoColorSpace, options: [quality: 0.6])
    }
}
#endif

#if canImport(UIKit)
import AVFoundation
import Combine
import Foundation

/// What is drawn on top of the video. Changes several times a second, so it
/// is kept apart from the rest of the app's state.
@MainActor
final class OverlayModel: ObservableObject {
    @Published var overlays: [TrackOverlay] = []
    @Published var otherText: [NormRect] = []
    /// Size of the analyzed frames in pixels, upright.
    @Published var frameSize = CGSize(width: 1920, height: 1080)
    /// Frames analyzed per second, averaged.
    @Published var scanRate = 0.0
}

/// Connects the camera, the analysis pipeline and the rest of the app.
///
/// The camera can be on without recording: bibs are then outlined on the
/// video, which is useful for aiming, but nothing is added to the results.
@MainActor
final class CaptureCoordinator: ObservableObject {
    @Published private(set) var cameraState = CameraController.State.idle
    @Published private(set) var isRecording = false

    let overlay = OverlayModel()
    let camera = CameraController()

    /// Receives what the camera recorded, and the race it was recorded for.
    var sightingHandler: (([BibSighting], UUID) -> Void)?

    private let pipeline: CapturePipeline
    private var settings = AppSettings()
    private var roster: Set<String>?
    private var cameraIsWanted = false
    /// Identifies the current (or most recent) recording.
    private var generation = 0
    /// Which race each recent recording belongs to. Results are matched to
    /// their recording, not to whatever is current when they arrive: the last
    /// ones of a recording come in after it has been stopped, possibly after
    /// the next has begun.
    private var recordingRaces: [Int: UUID] = [:]
    private var lastResultTime: Double?
    private let monotonic = SystemMonotonicClock()

    init(clock: RaceClock) {
        let pipeline = CapturePipeline(clock: clock)
        self.pipeline = pipeline

        let session = camera.session
        camera.frameHandler = { sampleBuffer in
            pipeline.process(sampleBuffer, synchronizationClock: session.synchronizationClock)
        }
        camera.stateHandler = { [weak self] state in
            self?.cameraStateChanged(state)
        }
        pipeline.resultHandler = { [weak self] result in
            onMain { self?.receive(result) }
        }
    }

    // MARK: Configuration

    /// Applies the operator's settings and the open race's start list.
    func configure(settings newSettings: AppSettings, roster newRoster: Set<String>?) {
        let oldCamera = cameraSettings
        settings = newSettings
        roster = newRoster

        let config = PipelineConfig(
            rules: newSettings.rules,
            roster: newRoster,
            recognizer: RecognizerOptions(zone: newSettings.effectiveScanZone, minimumTextHeight: newSettings.rules.minTextHeight),
            tracker: newSettings.trackerConfig,
            maxScanRate: newSettings.maxScanRate,
            savePhotos: newSettings.savePhotos,
            showAllText: newSettings.showAllText
        )
        let pipeline = self.pipeline
        camera.performOnVideoQueue {
            pipeline.update(config)
        }

        if cameraIsWanted, cameraSettings != oldCamera {
            camera.apply(cameraSettings)
        }
    }

    private var cameraSettings: CameraSettings {
        CameraSettings(highResolution: settings.highResolution, shutterLimit: settings.shutterLimit, zoom: settings.zoom)
    }

    // MARK: Camera

    func startCamera() {
        cameraIsWanted = true
        camera.start(cameraSettings)
    }

    func stopCamera() {
        stopRecording()
        cameraIsWanted = false
        camera.stop()
        overlay.overlays = []
        overlay.otherText = []
        overlay.scanRate = 0
        lastResultTime = nil
    }

    private func cameraStateChanged(_ state: CameraController.State) {
        cameraState = state
        if state != .running {
            overlay.overlays = []
            overlay.otherText = []
        }
    }

    // MARK: Recording

    func startRecording(raceID: UUID) {
        guard !isRecording else { return }
        let recording = generation + 1
        generation = recording
        recordingRaces[recording] = raceID
        recordingRaces = recordingRaces.filter { $0.key > recording - 4 }
        isRecording = true
        let pipeline = self.pipeline
        camera.performOnVideoQueue {
            pipeline.beginRecording(generation: recording)
        }
    }

    func stopRecording() {
        guard isRecording else { return }
        isRecording = false
        let pipeline = self.pipeline
        camera.performOnVideoQueue {
            pipeline.endRecording()
        }
    }

    private func receive(_ result: FrameResult) {
        // What was seen while only previewing belongs to no recording.
        if !result.sightings.isEmpty, let raceID = recordingRaces[result.generation] {
            sightingHandler?(result.sightings, raceID)
        }
        guard result.frameWidth > 0, cameraIsWanted else { return }

        let size = CGSize(width: result.frameWidth, height: result.frameHeight)
        if overlay.frameSize != size { overlay.frameSize = size }
        if overlay.overlays != result.overlays { overlay.overlays = result.overlays }
        if overlay.otherText != result.otherText { overlay.otherText = result.otherText }

        let now = monotonic.now()
        if let last = lastResultTime, now > last {
            let rate = 1 / (now - last)
            overlay.scanRate = overlay.scanRate == 0 ? rate : overlay.scanRate * 0.8 + rate * 0.2
        }
        lastResultTime = now
    }
}
#endif

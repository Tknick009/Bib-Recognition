#if canImport(UIKit)
import AVFoundation
import UIKit

/// The camera settings the operator can change.
struct CameraSettings: Equatable {
    var highResolution = false
    /// Longest exposure as 1/x s; 0 leaves exposure fully automatic.
    var shutterLimit = 250
    var zoom = 1.0
}

/// Owns the capture session for the back camera and delivers upright video
/// frames for analysis.
///
/// The preview layer and the frames handed to `frameHandler` are rotated the
/// same way, so what is analyzed is exactly what is shown.
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum State: Equatable {
        case idle
        case starting
        case running
        case interrupted
        case denied
        case failed(String)
    }

    let session = AVCaptureSession()
    let previewLayer: AVCaptureVideoPreviewLayer

    /// Called for every frame, on the video queue.
    var frameHandler: (@Sendable (CMSampleBuffer) -> Void)?
    /// Called on the main thread when the camera's state changes.
    var stateHandler: (@MainActor (State) -> Void)?

    private let sessionQueue = DispatchQueue(label: "bibtimer.camera.session")
    private let videoQueue = DispatchQueue(label: "bibtimer.camera.video", qos: .userInitiated)
    private let output = AVCaptureVideoDataOutput()

    // Only touched on the session queue.
    private var device: AVCaptureDevice?
    private var isConfigured = false
    private var wantsToRun = false
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []

    override init() {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        // Show the whole frame, so nothing that is analyzed is hidden.
        previewLayer.videoGravity = .resizeAspect
        super.init()
    }

    // MARK: Control

    /// Starts the camera, asking for permission first if necessary.
    func start(_ settings: CameraSettings) {
        report(.starting)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            sessionQueue.async { self.configureAndRun(settings) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted {
                    self.sessionQueue.async { self.configureAndRun(settings) }
                } else {
                    self.report(.denied)
                }
            }
        default:
            report(.denied)
        }
    }

    func stop() {
        sessionQueue.async {
            self.wantsToRun = false
            // Always, not only when running: an interrupted session is not
            // "running", but it would start again by itself once the
            // interruption is over.
            self.session.stopRunning()
            self.report(.idle)
        }
    }

    /// Applies new settings to a running camera.
    func apply(_ settings: CameraSettings) {
        sessionQueue.async {
            guard self.isConfigured else { return }
            self.configure(settings)
        }
    }

    /// Runs work on the queue that delivers frames, so it cannot overlap with
    /// the analysis of a frame.
    func performOnVideoQueue(_ work: @escaping @Sendable () -> Void) {
        videoQueue.async(execute: work)
    }

    // MARK: Session set-up (session queue)

    private func configureAndRun(_ settings: CameraSettings) {
        wantsToRun = true
        if !isConfigured {
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                report(.failed("This device has no back camera."))
                return
            }
            do {
                let input = try AVCaptureDeviceInput(device: camera)
                session.beginConfiguration()
                guard session.canAddInput(input), session.canAddOutput(output) else {
                    session.commitConfiguration()
                    report(.failed("The camera could not be set up."))
                    return
                }
                session.addInput(input)
                // Frames that arrive while the previous one is still being
                // analyzed are dropped, which keeps the analysis current.
                output.alwaysDiscardsLateVideoFrames = true
                output.videoSettings = [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                ]
                output.setSampleBufferDelegate(self, queue: videoQueue)
                session.addOutput(output)
                // Keep the camera available when the app shares the screen
                // with another app.
                if session.isMultitaskingCameraAccessSupported {
                    session.isMultitaskingCameraAccessEnabled = true
                }
                session.commitConfiguration()
            } catch {
                report(.failed(error.localizedDescription))
                return
            }
            device = camera
            isConfigured = true
            observeSession()
            observeRotation(of: camera)
        }
        configure(settings)
        if !session.isRunning {
            session.startRunning()
        }
        reportSessionState(ifStopped: "The camera could not start.")
    }

    /// Tells the app what the session is doing.
    private func reportSessionState(ifStopped problem: String) {
        guard wantsToRun else { return }
        if session.isRunning {
            report(.running)
        } else if session.isInterrupted {
            // Something else has the camera for now (another app, the app
            // not being in front). It starts by itself afterwards.
            report(.interrupted)
        } else {
            report(.failed(problem))
        }
    }

    private func configure(_ settings: CameraSettings) {
        guard let device else { return }

        let wanted: AVCaptureSession.Preset = settings.highResolution ? .hd4K3840x2160 : .hd1920x1080
        let preset = session.canSetSessionPreset(wanted) ? wanted : .hd1920x1080
        if session.sessionPreset != preset, session.canSetSessionPreset(preset) {
            session.beginConfiguration()
            session.sessionPreset = preset
            session.commitConfiguration()
        }

        do {
            try device.lockForConfiguration()
            // Only what differs is set: this runs for every step of the zoom
            // slider, and setting a value again can make the camera hunt.
            if device.isFocusModeSupported(.continuousAutoFocus), device.focusMode != .continuousAutoFocus {
                device.focusMode = .continuousAutoFocus
            }
            if device.isExposureModeSupported(.continuousAutoExposure), device.exposureMode != .continuousAutoExposure {
                device.exposureMode = .continuousAutoExposure
            }
            // A short exposure keeps a moving bib sharp; the camera makes up
            // for it with a higher sensitivity.
            let format = device.activeFormat
            var longestExposure = format.maxExposureDuration
            if settings.shutterLimit > 0 {
                let limit = CMTime(value: 1, timescale: CMTimeScale(settings.shutterLimit))
                longestExposure = CMTimeMaximum(format.minExposureDuration, CMTimeMinimum(limit, format.maxExposureDuration))
            }
            if CMTimeCompare(device.activeMaxExposureDuration, longestExposure) != 0 {
                // "Invalid" is how the camera is told to choose for itself.
                device.activeMaxExposureDuration = settings.shutterLimit > 0 ? longestExposure : .invalid
            }
            let lowest = device.minAvailableVideoZoomFactor
            let highest = min(device.maxAvailableVideoZoomFactor, CameraController.maxZoom)
            let zoom = min(max(CGFloat(settings.zoom), lowest), max(lowest, highest))
            if device.videoZoomFactor != zoom {
                device.videoZoomFactor = zoom
            }
            device.unlockForConfiguration()
        } catch {
            // The camera keeps running with its previous configuration.
        }
        applyRotation()
    }

    static let maxZoom: CGFloat = 6

    // MARK: Rotation

    private func observeRotation(of camera: AVCaptureDevice) {
        let coordinator = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: previewLayer)
        rotationCoordinator = coordinator
        rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, _ in
            guard let self else { return }
            self.sessionQueue.async { self.applyRotation() }
        }
    }

    /// Turns both the preview and the analyzed frames upright for the way the
    /// interface is currently oriented.
    private func applyRotation() {
        guard let coordinator = rotationCoordinator else { return }
        let angle = coordinator.videoRotationAngleForHorizonLevelPreview
        if let connection = output.connection(with: .video),
           connection.videoRotationAngle != angle, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
        let layer = previewLayer
        DispatchQueue.main.async {
            if let connection = layer.connection,
               connection.videoRotationAngle != angle, connection.isVideoRotationAngleSupported(angle) {
                connection.videoRotationAngle = angle
            }
        }
    }

    // MARK: Interruptions

    private func observeSession() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.sessionQueue.async {
                if self.wantsToRun { self.report(.interrupted) }
            }
        })
        // After an interruption the session starts again by itself, a moment
        // after it says the interruption is over. This is when it is back.
        observers.append(center.addObserver(forName: AVCaptureSession.didStartRunningNotification, object: session, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.sessionQueue.async {
                if self.wantsToRun { self.report(.running) }
            }
        })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] _ in
            guard let self else { return }
            // Most runtime errors (the media services restarting, for one)
            // are cured by starting the session again.
            self.sessionQueue.async {
                guard self.wantsToRun else { return }
                if !self.session.isRunning {
                    self.session.startRunning()
                }
                self.reportSessionState(ifStopped: "The camera stopped unexpectedly.")
            }
        })
    }

    private func report(_ state: State) {
        onMain { [weak self] in
            self?.stateHandler?(state)
        }
    }

    // MARK: AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        frameHandler?(sampleBuffer)
    }
}
#endif

#if canImport(UIKit)
import SwiftUI
import UIKit

/// The timing screen: live video with the bibs being read, the race clock,
/// the controls and the list of results.
struct RaceView: View {
    let raceID: UUID

    @EnvironmentObject private var store: RaceStore
    @EnvironmentObject private var settingsStore: SettingsStore
    @EnvironmentObject private var capture: CaptureCoordinator
    @EnvironmentObject private var time: TimeService
    @Environment(\.scenePhase) private var scenePhase

    @State private var isAdjusting = false
    @State private var editing: Crossing?
    @State private var activeSheet: RaceSheet?

    enum RaceSheet: String, Identifiable {
        case setup
        case export
        case settings
        case sync

        var id: String { rawValue }
    }

    var body: some View {
        GeometryReader { proxy in
            if proxy.size.width >= 700 && proxy.size.width > proxy.size.height {
                HStack(spacing: 0) {
                    preview
                    Divider()
                    panel.frame(width: min(420, proxy.size.width * 0.4))
                }
            } else {
                VStack(spacing: 0) {
                    preview.frame(height: proxy.size.height * 0.42)
                    Divider()
                    panel
                }
            }
        }
        .navigationTitle(store.race?.name ?? "Race")
        .navigationBarTitleDisplayMode(.inline)
        // Leaving this screen stops the camera. While recording, or while
        // dragging handles around the picture, there is no Back button and no
        // swipe back, so that cannot happen by accident: stop first.
        .navigationBarBackButtonHidden(capture.isRecording || isAdjusting)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    isAdjusting.toggle()
                } label: {
                    Label("Adjust", systemImage: isAdjusting ? "checkmark.circle.fill" : "viewfinder")
                }
                Button {
                    activeSheet = .export
                } label: {
                    Label("Export", systemImage: "square.and.arrow.up")
                }
                Menu {
                    Button {
                        activeSheet = .setup
                    } label: {
                        Label("Race setup", systemImage: "flag.checkered")
                    }
                    Button {
                        activeSheet = .settings
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    Button {
                        activeSheet = .sync
                    } label: {
                        Label("Time sync", systemImage: "clock.arrow.2.circlepath")
                    }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .setup: RaceSetupView()
            case .export: ExportView()
            case .settings: SettingsView()
            case .sync: SyncDetailView()
            }
        }
        .sheet(item: $editing) { crossing in
            CrossingEditor(crossingID: crossing.id)
        }
        .onAppear {
            store.open(raceID)
            capture.startCamera()
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            // The race stays open in the store: stopping the camera hands over
            // the bibs still being followed, and those arrive a moment later.
            capture.stopCamera()
            store.flush()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                // Back in front. If the camera is not running (access was
                // only just granted in Settings, or it did not come back by
                // itself after being interrupted), start it.
                if capture.cameraState != .running {
                    capture.startCamera()
                }
            } else {
                // Whatever happens next, the results are on disk.
                store.flush(synchronously: true)
            }
        }
    }

    // MARK: Video

    private var preview: some View {
        ZStack {
            Color.black
            CameraPreview(layer: capture.camera.previewLayer)
            DetectionOverlay(
                model: capture.overlay,
                settings: settingsStore.settings,
                recordedBibs: Set(store.race?.crossings.map(\.bib) ?? []),
                isRecording: capture.isRecording
            )
            if isAdjusting {
                AdjustOverlay(model: capture.overlay, settings: $settingsStore.settings)
            }
            cameraMessage
            VStack {
                HStack(alignment: .top) {
                    if capture.isRecording {
                        Label("REC", systemImage: "record.circle.fill")
                            .font(.subheadline.weight(.bold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.red, in: Capsule())
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    ScanRateBadge(model: capture.overlay)
                }
                Spacer()
            }
            .padding(10)
        }
        .clipped()
    }

    @ViewBuilder
    private var cameraMessage: some View {
        switch capture.cameraState {
        case .denied:
            notice("Camera access is off",
                   detail: "Allow camera access for Bib Timer in the Settings app to read bibs. Times can still be marked by hand.")
        case .failed(let reason):
            notice("Camera unavailable", detail: reason)
        case .interrupted:
            notice("Camera paused", detail: "Another app is using the camera, or Bib Timer is not in front.")
        case .idle, .starting, .running:
            EmptyView()
        }
    }

    private func notice(_ title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "video.slash.fill").font(.title)
            Text(title).font(.headline)
            Text(detail).font(.subheadline).multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(20)
        .frame(maxWidth: 360)
        .background(Color.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 14))
    }

    /// Controls shown while the finish line and scan zone are being set up.
    /// They take the place of the clock, beside the picture rather than on it,
    /// so every handle stays within reach.
    private var adjustBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(settingsStore.settings.timingMode == .line
                 ? "Drag the orange dots to put the line where bibs are as runners finish. The arrow shows the running direction. Blue dots set the area that is searched."
                 : "Drag the blue dots to set the area that is searched for bibs.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 14) {
                Image(systemName: "minus.magnifyingglass")
                Slider(value: $settingsStore.settings.zoom, in: 1...Double(CameraController.maxZoom))
                    .frame(minWidth: 100)
                Image(systemName: "plus.magnifyingglass")
                if settingsStore.settings.timingMode == .line {
                    Button("Flip") {
                        settingsStore.settings.line.reversed.toggle()
                    }
                }
                Button("Reset") {
                    settingsStore.settings.line = .standard
                    settingsStore.settings.scanZone = .full
                    settingsStore.settings.zoom = 1
                }
                Button("Done") {
                    isAdjusting = false
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: Clock, controls and results

    private var panel: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button {
                        activeSheet = .sync
                    } label: {
                        SyncChip()
                    }
                    .buttonStyle(.plain)
                    Button {
                        activeSheet = .setup
                    } label: {
                        HubChip()
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    if let message = store.saveError {
                        Label("Not saved", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.red)
                            .help(message)
                    }
                }
                if isAdjusting {
                    adjustBar
                } else {
                    ClockDisplay(clock: time.clock, startTime: store.race?.startTime)
                    controls
                }
            }
            .padding(12)
            Divider()
            if let race = store.race {
                ResultsList(race: race) { crossing in
                    editing = crossing
                }
            } else {
                ContentUnavailableView("Race not found", systemImage: "questionmark.folder")
            }
        }
        .background(Color(.systemBackground))
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button {
                if capture.isRecording {
                    capture.stopRecording()
                } else {
                    capture.startRecording(raceID: raceID)
                }
            } label: {
                Label(capture.isRecording ? "Stop" : "Record",
                      systemImage: capture.isRecording ? "stop.fill" : "record.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(capture.isRecording ? Color.red : Color.accentColor)
            .disabled(capture.cameraState != .running && !capture.isRecording)

            Button {
                let now = time.clock.now()
                store.addManualMark(time: now.date, clock: now.clock)
            } label: {
                Label("Mark", systemImage: "hand.tap.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            if store.race?.startTime == nil {
                Button {
                    let now = time.clock.now().date
                    store.update { $0.startTime = now }
                } label: {
                    Label("Start", systemImage: "flag.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.green)
            }
        }
        .controlSize(.large)
        .font(.headline)
    }
}

/// Shows how many frames per second are being analyzed.
struct ScanRateBadge: View {
    @ObservedObject var model: OverlayModel

    var body: some View {
        if model.scanRate > 0 {
            Text(String(format: "%.0f scans/s", model.scanRate))
                .font(.caption.monospacedDigit())
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.55), in: Capsule())
                .foregroundStyle(.white)
        }
    }
}
#endif

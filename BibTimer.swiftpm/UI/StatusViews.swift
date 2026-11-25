#if canImport(UIKit)
import SwiftUI

extension TimeService.Level {
    var color: Color {
        switch self {
        case .good: return .green
        case .fair: return .orange
        case .poor, .unsynced: return .red
        }
    }

    var symbol: String {
        switch self {
        case .good: return "checkmark.circle.fill"
        case .fair: return "exclamationmark.circle.fill"
        case .poor: return "exclamationmark.triangle.fill"
        case .unsynced: return "wifi.slash"
        }
    }
}

/// A small badge that says how well the race clock is synchronized.
struct SyncChip: View {
    @EnvironmentObject private var time: TimeService

    var body: some View {
        // The error bound grows as the fix ages, so refresh now and then.
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            let level = time.level
            HStack(spacing: 6) {
                if time.isSyncing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: level.symbol)
                }
                Text(level == .unsynced ? "Not synced · iPad clock" : time.summary)
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(level.color)
            .background(level.color.opacity(0.15), in: Capsule())
        }
    }
}

/// A small badge that says whether results are reaching the results server.
/// Shows nothing when no server has been set up.
struct HubChip: View {
    @EnvironmentObject private var hub: HubSync

    var body: some View {
        if let look = HubChip.look(for: hub.status) {
            Label(look.text, systemImage: look.symbol)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .foregroundStyle(look.color)
                .background(look.color.opacity(0.15), in: Capsule())
        }
    }

    private static func look(for status: HubSync.Status) -> (text: String, symbol: String, color: Color)? {
        switch status {
        case .off, .idle:
            return nil
        case .paused:
            return ("Not shared", "icloud.slash", Color.secondary)
        case .waiting(let count):
            return (count > 0 ? "Sending \(count)" : "Sending", "arrow.up.circle", Color.orange)
        case .upToDate:
            return ("Shared", "checkmark.icloud.fill", Color.green)
        case .failed:
            return ("Not sent yet", "exclamationmark.icloud.fill", Color.red)
        }
    }
}

/// The running race clock: elapsed time once the race has a start time, and
/// the time of day.
struct ClockDisplay: View {
    let clock: RaceClock
    let startTime: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let now = clock.now().date
            VStack(alignment: .leading, spacing: 0) {
                if let startTime {
                    Text(TimeFormat.elapsed(from: startTime, to: now, decimals: 1))
                        .font(.system(size: 44, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text("Time of day " + TimeFormat.timeOfDay(now, timeZone: .current, decimals: 1))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else {
                    Text(TimeFormat.timeOfDay(now, timeZone: .current, decimals: 1))
                        .font(.system(size: 44, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    Text("Time of day · race not started")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        }
    }
}

/// Everything about the clock synchronization, and a button to do it now.
struct SyncDetailView: View {
    @EnvironmentObject private var time: TimeService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Form {
                    statusSection
                    if let fix = time.fix {
                        fixSection(fix)
                    }
                    serversSection
                    Section {
                        Button {
                            Task { await time.sync() }
                        } label: {
                            HStack {
                                Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                                if time.isSyncing {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(time.isSyncing)
                    } footer: {
                        Text("The clock is checked against the time servers every few minutes while there is a connection. A sync is kept until the iPad is restarted, so you can sync where there is Wi-Fi and time a race where there is none. Without a sync, times come from the iPad's own clock and are marked as such.")
                    }
                }
            }
            .navigationTitle("Time sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var statusSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: time.level.symbol)
                    .font(.largeTitle)
                    .foregroundStyle(time.level.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline).font(.headline)
                    Text(TimeFormat.timeOfDay(time.clock.now().date, timeZone: .current, decimals: 1))
                        .font(.title2.monospacedDigit())
                }
            }
            if let error = time.lastError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
        }
    }

    private var headline: String {
        guard let uncertainty = time.currentUncertainty else {
            return "Not synced: using the iPad's clock"
        }
        return "Synced to within " + TimeService.formatError(uncertainty)
    }

    private func fixSection(_ fix: ClockFix) -> some View {
        Section("Current sync") {
            LabeledContent("Server", value: fix.server)
            LabeledContent("Taken", value: TimeService.formatAge(time.fixAge ?? 0))
            if let contact = time.lastContact {
                LabeledContent("Last checked", value: TimeService.formatAge(time.clock.monoNow() - contact))
            }
            LabeledContent("Accuracy when taken", value: TimeService.formatError(fix.uncertainty))
            LabeledContent("Network round trip", value: String(format: "%.0f ms", fix.delay * 1000))
            LabeledContent("Servers in agreement", value: "\(fix.agreeing) of \(fix.responding)")
            LabeledContent("iPad clock was", value: SyncDetailView.describeOffset(fix.deviceClockError))
        }
    }

    private var serversSection: some View {
        Section("Servers") {
            if time.reports.isEmpty {
                Text("No sync has been attempted yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(time.reports) { report in
                VStack(alignment: .leading, spacing: 2) {
                    Text(report.server)
                    if let sample = report.sample {
                        Text("Round trip \(String(format: "%.0f", sample.delay * 1000)) ms · stratum \(sample.stratum) · \(TimeService.formatError(sample.errorBound))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(report.error ?? "No answer")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    private static func describeOffset(_ seconds: Double) -> String {
        let magnitude = abs(seconds)
        let text = magnitude < 1 ? String(format: "%.0f ms", magnitude * 1000) : String(format: "%.2f s", magnitude)
        if magnitude < 0.0005 { return "exactly right" }
        return text + (seconds > 0 ? " fast" : " slow")
    }
}
#endif

#if canImport(UIKit)
import SwiftUI
import UIKit

/// The race's results, most recent first.
struct ResultsList: View {
    let race: Race
    let onSelect: (Crossing) -> Void

    @EnvironmentObject private var store: RaceStore

    var body: some View {
        let newestFirst = Array(race.sortedCrossings.reversed())
        let duplicates = race.duplicateBibs
        let names = race.rosterNames
        let total = newestFirst.count

        VStack(spacing: 0) {
            HStack {
                Text(total == 1 ? "1 result" : "\(total) results")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if !duplicates.isEmpty {
                    Label("\(duplicates.count) duplicated", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            List {
                ForEach(Array(newestFirst.enumerated()), id: \.element.id) { index, crossing in
                    Button {
                        onSelect(crossing)
                    } label: {
                        CrossingRow(
                            crossing: crossing,
                            position: total - index,
                            startTime: race.startTime,
                            name: names[crossing.bib],
                            isDuplicate: duplicates.contains(crossing.bib),
                            thumbnail: store.thumbnail(for: crossing)
                        )
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            store.deleteCrossing(crossing.id)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if newestFirst.isEmpty {
                    ContentUnavailableView(
                        "No results yet",
                        systemImage: "figure.run",
                        description: Text("Press Record and bibs are added as the camera reads them. Mark adds a time by hand.")
                    )
                }
            }
        }
    }
}

struct CrossingRow: View {
    let crossing: Crossing
    let position: Int
    let startTime: Date?
    let name: String?
    let isDuplicate: Bool
    let thumbnail: UIImage?

    var body: some View {
        HStack(spacing: 12) {
            Text("\(position)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 32, alignment: .trailing)

            Text(crossing.bib.isEmpty ? "?" : crossing.bib)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(crossing.bib.isEmpty || isDuplicate ? Color.orange : Color.primary)
                .frame(minWidth: 72, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(timeText)
                    .font(.body.monospacedDigit().weight(.medium))
                HStack(spacing: 5) {
                    if let name, !name.isEmpty {
                        Text(name).lineLimit(1)
                    }
                    ForEach(tags, id: \.self) { tag in
                        Text(tag)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.16), in: Capsule())
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            if let thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 44, height: 58)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var timeText: String {
        if let startTime {
            return TimeFormat.elapsed(from: startTime, to: crossing.time, decimals: 2)
        }
        return TimeFormat.timeOfDay(crossing.time, timeZone: .current, decimals: 2)
    }

    private var tags: [String] {
        var tags: [String] = []
        if crossing.source == .manual { tags.append("by hand") }
        if crossing.timing == .estimated { tags.append("estimated") }
        if crossing.detectedBib != nil { tags.append("edited") }
        if isDuplicate { tags.append("duplicate") }
        if crossing.clock.source == .device { tags.append("iPad clock") }
        return tags
    }
}

/// Lets the operator correct a result: its bib number and a note.
struct CrossingEditor: View {
    let crossingID: UUID

    @EnvironmentObject private var store: RaceStore
    @EnvironmentObject private var settingsStore: SettingsStore
    @Environment(\.dismiss) private var dismiss

    @State private var bibText = ""
    @State private var note = ""
    /// What the fields showed when the editor opened.
    @State private var openedBib = ""
    @State private var openedNote = ""
    @State private var loaded = false
    @FocusState private var bibFocused: Bool

    private var crossing: Crossing? {
        store.race?.crossings.first { $0.id == crossingID }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let crossing {
                    if let image = store.thumbnail(for: crossing) {
                        Section {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: 340)
                        }
                    }
                    Section("Bib number") {
                        TextField("Bib", text: $bibText)
                            .keyboardType(.numberPad)
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .focused($bibFocused)
                        if let detected = crossing.detectedBib {
                            LabeledContent("Camera read", value: detected.isEmpty ? "nothing" : detected)
                        }
                    }
                    Section("Time") {
                        LabeledContent("Time of day", value: TimeFormat.timeOfDay(crossing.time, timeZone: .current))
                        if let start = store.race?.startTime {
                            LabeledContent("Elapsed", value: TimeFormat.elapsed(from: start, to: crossing.time))
                        }
                        LabeledContent("Taken", value: CrossingEditor.describe(crossing.timing))
                        LabeledContent("Clock", value: CrossingEditor.describe(crossing.clock))
                        if let sightings = crossing.sightings {
                            LabeledContent("Frames read", value: "\(sightings)")
                        }
                    }
                    Section("Note") {
                        TextField("Note", text: $note, axis: .vertical)
                    }
                    Section {
                        if !crossing.bib.isEmpty, crossing.source == .camera {
                            Button("Delete and never record \(crossing.bib)") {
                                ignore(crossing.bib)
                            }
                        }
                        Button("Delete this result", role: .destructive) {
                            store.deleteCrossing(crossingID)
                            dismiss()
                        }
                    }
                } else {
                    Text("This result no longer exists.")
                }
            }
            .navigationTitle("Result")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        // Only what was actually edited is written, so a
                        // number the camera corrected in the meantime is not
                        // put back to what it was when this opened.
                        if bibText != openedBib {
                            store.setBib(bibText, for: crossingID)
                        }
                        if note != openedNote {
                            store.setNote(note, for: crossingID)
                        }
                        dismiss()
                    }
                }
            }
            .onAppear {
                guard !loaded, let crossing else { return }
                loaded = true
                bibText = crossing.bib
                note = crossing.note
                openedBib = crossing.bib
                openedNote = crossing.note
                // A mark without a number is opened to type the number. The
                // keyboard only comes up once the sheet has settled.
                if crossing.bib.isEmpty {
                    Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        bibFocused = true
                    }
                }
            }
        }
    }

    /// Deletes the result and stops the camera recording that number: for a
    /// number on a banner or a vehicle that keeps being read.
    private func ignore(_ bib: String) {
        if !settingsStore.settings.rules.ignored.contains(bib) {
            settingsStore.settings.rules.ignored.append(bib)
        }
        store.deleteCrossing(crossingID)
        dismiss()
    }

    private static func describe(_ timing: TimingKind) -> String {
        switch timing {
        case .line: return "Crossing the finish line"
        case .estimated: return "Nearest sighting to the line"
        case .firstSeen: return "First sighting"
        case .lastSeen: return "Last sighting"
        case .manual: return "By hand"
        }
    }

    private static func describe(_ clock: ClockStamp) -> String {
        switch clock.source {
        case .device:
            return "iPad clock (not synced)"
        case .ntp:
            guard let uncertainty = clock.uncertainty else { return "NTP" }
            return "NTP " + TimeService.formatError(uncertainty)
        }
    }
}
#endif

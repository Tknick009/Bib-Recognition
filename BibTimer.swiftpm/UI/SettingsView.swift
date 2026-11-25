#if canImport(UIKit)
import SwiftUI

/// How this iPad reads bibs and takes times.
struct SettingsView: View {
    @EnvironmentObject private var settingsStore: SettingsStore
    @Environment(\.dismiss) private var dismiss

    @State private var serversText = ""
    @State private var ignoredText = ""
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                stationSection
                timingSection
                bibSection
                readingSection
                cameraSection
                serversSection
                Section {
                    Button("Restore default settings", role: .destructive) {
                        let station = settingsStore.settings.station
                        var fresh = AppSettings()
                        fresh.station = station
                        settingsStore.settings = fresh
                        load()
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if !loaded {
                    loaded = true
                    load()
                }
            }
        }
    }

    private func load() {
        serversText = settingsStore.settings.ntpServers.joined(separator: "\n")
        ignoredText = settingsStore.settings.rules.ignored.joined(separator: ", ")
    }

    // MARK: Sections

    private var stationSection: some View {
        Section {
            TextField("Station name", text: $settingsStore.settings.station)
        } header: {
            Text("This iPad")
        } footer: {
            Text("Written into every export, so files from several iPads (start, splits, finish) can be told apart.")
        }
    }

    private var timingSection: some View {
        Section {
            Picker("Time is taken", selection: $settingsStore.settings.timingMode) {
                Text("At the finish line").tag(TimingMode.line)
                Text("When first read").tag(TimingMode.firstSeen)
                Text("When last read").tag(TimingMode.lastSeen)
            }
            Toggle("Record a bib more than once", isOn: $settingsStore.settings.repeatRule.allowRepeats)
            if settingsStore.settings.repeatRule.allowRepeats {
                Stepper(value: $settingsStore.settings.repeatRule.minInterval, in: 5...3600, step: 5) {
                    Text("At least \(Int(settingsStore.settings.repeatRule.minInterval)) s apart")
                }
            }
        } header: {
            Text("Timing")
        } footer: {
            Text(timingFootnote)
        }
    }

    private var timingFootnote: String {
        switch settingsStore.settings.timingMode {
        case .line:
            return "The time is worked out for the moment the bib crosses the line drawn on the video (set it with Adjust). A bib read on only one side of the line gets its nearest sighting and is marked as estimated. Turn on repeats for races with laps."
        case .firstSeen:
            return "The time is the first frame in which the bib was read. Turn on repeats for races with laps."
        case .lastSeen:
            return "The time is the last frame in which the bib was read, known once the bib has left the picture. Turn on repeats for races with laps."
        }
    }

    private var bibSection: some View {
        Section {
            Stepper(value: $settingsStore.settings.rules.minDigits, in: 1...max(settingsStore.settings.rules.maxDigits, 1)) {
                Text("At least \(settingsStore.settings.rules.minDigits) digits")
            }
            Stepper(value: $settingsStore.settings.rules.maxDigits, in: min(max(settingsStore.settings.rules.minDigits, 1), 8)...8) {
                Text("At most \(settingsStore.settings.rules.maxDigits) digits")
            }
            LabeledContent("Lowest number") {
                TextField("Any", value: $settingsStore.settings.rules.minNumber, format: .number.grouping(.never))
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("Highest number") {
                TextField("Any", value: $settingsStore.settings.rules.maxNumber, format: .number.grouping(.never))
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("Never record") {
                TextField("e.g. 2026", text: $ignoredText)
                    .keyboardType(.numbersAndPunctuation)
                    .multilineTextAlignment(.trailing)
                    .onChange(of: ignoredText) { _, text in
                        let numbers = text.split(whereSeparator: { !$0.isNumber }).compactMap { BibFilter.canonical(String($0)) }
                        settingsStore.settings.rules.ignored = numbers
                    }
            }
        } header: {
            Text("Bib numbers")
        } footer: {
            Text("The tighter these match the bibs actually in the race, the fewer stray numbers are picked up. A start list (in Race setup) is the surest filter of all.")
        }
    }

    private var readingSection: some View {
        Section {
            Stepper(value: $settingsStore.settings.minSightings, in: 1...6) {
                Text("Read in \(settingsStore.settings.minSightings) frames before it counts")
            }
            Picker("Certainty required", selection: $settingsStore.settings.rules.minConfidence) {
                Text("Low").tag(0.25)
                Text("Medium").tag(0.4)
                Text("High").tag(0.9)
            }
            VStack(alignment: .leading) {
                Text("Smallest text: \(String(format: "%.1f", settingsStore.settings.rules.minTextHeight * 100)) % of the picture height")
                Slider(value: $settingsStore.settings.rules.minTextHeight, in: 0.008...0.08)
            }
            Toggle("Accept a look-alike letter (O for 0, I for 1…)", isOn: $settingsStore.settings.rules.fixLookalikes)
            Toggle("Keep a photo of each result", isOn: $settingsStore.settings.savePhotos)
            Toggle("Outline rejected text", isOn: $settingsStore.settings.showAllText)
        } header: {
            Text("Reading")
        } footer: {
            Text("Smaller text reaches bibs further away but slows each scan. Outlining rejected text helps when working out why a number is not being picked up.")
        }
    }

    private var cameraSection: some View {
        Section {
            Toggle("4K video", isOn: $settingsStore.settings.highResolution)
            Picker("Longest exposure", selection: $settingsStore.settings.shutterLimit) {
                ForEach(AppSettings.shutterChoices, id: \.self) { choice in
                    Text(choice == 0 ? "Automatic" : "1/\(choice) s").tag(choice)
                }
            }
            Picker("Scans per second", selection: $settingsStore.settings.maxScanRate) {
                ForEach(AppSettings.scanRateChoices, id: \.self) { choice in
                    Text(choice == 0 ? "As many as possible" : "Up to \(Int(choice))").tag(choice)
                }
            }
        } header: {
            Text("Camera")
        } footer: {
            Text("A short exposure keeps moving bibs sharp; in poor light choose a longer one or Automatic. 4K records more detail: lower Smallest text as well to read bibs further away, at the cost of slower scans. Fewer scans per second keep the iPad cooler on a long day.")
        }
    }

    private var serversSection: some View {
        Section {
            TextField("One server per line", text: $serversText, axis: .vertical)
                .lineLimit(3...8)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .onChange(of: serversText) { _, text in
                    settingsStore.settings.ntpServers = text
                        .split(whereSeparator: { $0.isNewline || $0 == "," || $0 == " " })
                        .map(String.init)
                }
        } header: {
            Text("NTP time servers")
        } footer: {
            Text("One per line. The clock uses the answer most servers agree on. To use a time server on your own network, enter its address here (add :port if it is not 123).")
        }
    }
}
#endif

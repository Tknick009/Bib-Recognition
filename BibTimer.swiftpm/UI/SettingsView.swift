#if canImport(UIKit)
import SwiftUI

/// How this iPad reads bibs and takes times.
struct SettingsView: View {
    @EnvironmentObject private var settingsStore: SettingsStore
    @EnvironmentObject private var hub: HubSync
    @Environment(\.dismiss) private var dismiss

    @State private var serversText = ""
    @State private var ignoredText = ""
    @State private var loaded = false
    @State private var hubCheck: HubCheck?
    @State private var isCheckingHub = false
    /// What is typed in the server fields. It only replaces the address and
    /// key in use once the server has answered.
    @State private var hubAddressDraft = ""
    @State private var hubKeyDraft = ""

    /// The outcome of a connection check.
    struct HubCheck: Equatable {
        var ok: Bool
        var message: String
        /// What the fields showed when it was made. The outcome is only
        /// shown for as long as they still show the same.
        var address: String
        var key: String
    }

    var body: some View {
        NavigationStack {
            Form {
                stationSection
                timingSection
                bibSection
                readingSection
                cameraSection
                serversSection
                hubSection
                Section {
                    Button("Restore default settings", role: .destructive) {
                        // Who this iPad is and where it sends results are kept.
                        var fresh = AppSettings()
                        fresh.station = settingsStore.settings.station
                        fresh.hubAddress = settingsStore.settings.hubAddress
                        fresh.hubKey = settingsStore.settings.hubKey
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
        hubAddressDraft = settingsStore.settings.hubAddress
        hubKeyDraft = settingsStore.settings.hubKey
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

    private var hubSection: some View {
        Section {
            TextField("Server address", text: $hubAddressDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            TextField("Access key", text: $hubKeyDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button {
                Task { await connectHub() }
            } label: {
                HStack {
                    Text(hubIsAsEntered ? "Check the connection" : "Connect")
                    if isCheckingHub {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isCheckingHub)
            if let hubCheck, hubCheck.address == hubAddressDraft, hubCheck.key == hubKeyDraft {
                Label(hubCheck.message, systemImage: hubCheck.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(hubCheck.ok ? Color.green : Color.red)
            }
            if settingsStore.settings.hub != nil {
                Button("Stop sending results", role: .destructive) {
                    settingsStore.settings.hubAddress = ""
                    settingsStore.settings.hubKey = ""
                    hubAddressDraft = ""
                    hubKeyDraft = ""
                    hubCheck = nil
                }
            }
        } header: {
            Text("Live results")
        } footer: {
            Text("Optional. If you run the Bib Timer results server, enter its address and access key here, the same on every iPad, and tap Connect. Results are then copied to it as they are recorded, for your scoring computer to read. Everything is still saved on this iPad first, and nothing is lost if the connection drops. A new address and key only come into use once the server there has accepted the key.")
        }
    }

    /// True when the fields show the address and key that are in use.
    private var hubIsAsEntered: Bool {
        settingsStore.settings.hub != nil
            && hubAddressDraft == settingsStore.settings.hubAddress
            && hubKeyDraft == settingsStore.settings.hubKey
    }

    /// Asks the server at the entered address whether it accepts the entered
    /// key, and only then puts the two into use.
    @MainActor
    private func connectHub() async {
        let typedAddress = hubAddressDraft
        let typedKey = hubKeyDraft
        let address = typedAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = HubPlanner.normalizedKey(typedKey)
        guard let base = HubPlanner.baseURL(from: address) else {
            hubCheck = HubCheck(ok: false, message: "Enter the server's address, for example my-results.up.railway.app.", address: typedAddress, key: typedKey)
            return
        }
        guard !key.isEmpty else {
            hubCheck = HubCheck(ok: false, message: "Enter the access key.", address: typedAddress, key: typedKey)
            return
        }
        isCheckingHub = true
        defer { isCheckingHub = false }

        var problem: String
        do {
            let ping = try await HubClient(base: base, key: key).ping()
            if ping.access == "full" {
                settingsStore.settings.hubAddress = address
                settingsStore.settings.hubKey = key
                // The fields show what is now in use, unless they have been
                // typed in again in the meantime.
                if hubAddressDraft == typedAddress { hubAddressDraft = address }
                if hubKeyDraft == typedKey { hubKeyDraft = key }
                let message = ping.persistent == false
                    ? "Connected. The server is keeping results in memory only."
                    : "Connected."
                hubCheck = HubCheck(ok: true, message: message, address: address, key: key)
                // Uploads that were waiting to try again need wait no longer.
                hub.retryNow()
                return
            }
            problem = "This key can only view results. iPads need the main access key."
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        let inUse = settingsStore.settings
        if inUse.hub != nil, inUse.hubAddress != address || inUse.hubKey != key {
            problem += " Results still go to the server that was set up before."
        }
        hubCheck = HubCheck(ok: false, message: problem, address: typedAddress, key: typedKey)
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

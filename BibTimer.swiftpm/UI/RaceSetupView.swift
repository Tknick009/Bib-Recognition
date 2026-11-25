#if canImport(UIKit)
import SwiftUI
import UniformTypeIdentifiers

/// Things that belong to one race: its name, start time and start list.
struct RaceSetupView: View {
    @EnvironmentObject private var store: RaceStore
    @EnvironmentObject private var time: TimeService
    @EnvironmentObject private var settingsStore: SettingsStore
    @EnvironmentObject private var hub: HubSync
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var startDay = Date()
    @State private var startClock = ""
    @State private var startProblem: String?
    @State private var rosterText = ""
    @State private var importingRoster = false
    @State private var rosterProblem: String?
    @State private var confirmingClear = false
    @State private var retimeMessage: String?
    @State private var codeText = ""
    @State private var codeProblem: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Race name", text: $name)
                        .onChange(of: name) { _, text in
                            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty {
                                store.update { $0.name = trimmed }
                            }
                        }
                }
                startSection
                rosterSection
                hubSection
                if let race = store.race, race.deviceClockCount > 0 {
                    clockSection(count: race.deviceClockCount)
                }
                Section {
                    Button("Delete all results", role: .destructive) {
                        confirmingClear = true
                    }
                    .disabled(store.race?.crossings.isEmpty ?? true)
                }
            }
            .navigationTitle("Race setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Delete every result of this race?", isPresented: $confirmingClear, titleVisibility: .visible) {
                Button("Delete all results", role: .destructive) {
                    store.deleteAllCrossings()
                }
            } message: {
                Text("This cannot be undone. Export first if you may need them.")
            }
            .fileImporter(isPresented: $importingRoster, allowedContentTypes: [.commaSeparatedText, .tabSeparatedText, .plainText]) { result in
                importRoster(result)
            }
            .onAppear {
                guard !loaded, let race = store.race else { return }
                loaded = true
                name = race.name
                codeText = race.eventCode(timeZone: .current)
                if let start = race.startTime {
                    startDay = start
                    startClock = TimeFormat.timeOfDay(start, timeZone: .current, decimals: 1)
                }
            }
        }
    }

    // MARK: Start time

    private var startSection: some View {
        Section {
            if let start = store.race?.startTime {
                LabeledContent("Started", value: TimeFormat.localDate(start, timeZone: .current) + "  " + TimeFormat.timeOfDay(start, timeZone: .current, decimals: 1))
            } else {
                Text("No start time yet").foregroundStyle(.secondary)
            }
            Button("Start now") {
                setStart(time.clock.now().date)
            }
            DatePicker("Day", selection: $startDay, displayedComponents: .date)
            LabeledContent("Time of day") {
                TextField("9:30:00.0", text: $startClock)
                    .keyboardType(.numbersAndPunctuation)
                    .multilineTextAlignment(.trailing)
            }
            Button("Set this start time") {
                applyTypedStart()
            }
            .disabled(startClock.trimmingCharacters(in: .whitespaces).isEmpty)
            if let startProblem {
                Text(startProblem).foregroundStyle(.red)
            }
            if store.race?.startTime != nil {
                Button("Clear start time", role: .destructive) {
                    store.update { $0.startTime = nil }
                }
            }
        } header: {
            Text("Start time")
        } footer: {
            Text("Elapsed times are measured from the start. Every synced iPad has the same time of day, so the start can be taken on one iPad and typed into the others, as hours:minutes:seconds in 24-hour time.")
        }
    }

    private func setStart(_ date: Date) {
        store.update { $0.startTime = date }
        startDay = date
        startClock = TimeFormat.timeOfDay(date, timeZone: .current, decimals: 1)
        startProblem = nil
    }

    private func applyTypedStart() {
        guard let seconds = TimeFormat.parseTimeOfDay(startClock) else {
            startProblem = "Enter the time as hours:minutes:seconds, for example 9:30:00 or 14:05:30.5."
            return
        }
        guard let moment = TimeFormat.moment(on: startDay, secondsIntoDay: seconds, calendar: .current) else {
            startProblem = "That time does not exist on that day."
            return
        }
        setStart(moment)
    }

    // MARK: Start list

    private var rosterSection: some View {
        Section {
            if let race = store.race, !race.roster.isEmpty {
                LabeledContent("Runners on the list", value: "\(race.roster.count)")
                Toggle("Only record bibs on the list", isOn: Binding(
                    get: { store.race?.restrictToRoster ?? false },
                    set: { value in store.update { $0.restrictToRoster = value } }
                ))
                Button("Remove the start list", role: .destructive) {
                    store.update {
                        $0.roster = []
                        $0.restrictToRoster = false
                    }
                }
            }
            TextField("Paste a list: 101, Jane Doe", text: $rosterText, axis: .vertical)
                .lineLimit(3...8)
                .autocorrectionDisabled()
            Button("Use the pasted list") {
                useRoster(rosterText)
            }
            .disabled(rosterText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Import a file…") {
                importingRoster = true
            }
            if let rosterProblem {
                Text(rosterProblem).foregroundStyle(.red)
            }
        } header: {
            Text("Start list")
        } footer: {
            Text("Optional. One runner per line with the bib number first, then the name; CSV exports from a spreadsheet work as they are. Names appear in the results, and the camera can be told to accept only bibs on the list, which stops stray numbers being recorded.")
        }
    }

    private func useRoster(_ text: String) {
        let entries = RosterParser.parse(text)
        guard !entries.isEmpty else {
            rosterProblem = "No bib numbers were found. Each line should start with a bib number."
            return
        }
        store.update { race in
            race.roster = entries
            race.restrictToRoster = true
        }
        rosterProblem = nil
        rosterText = ""
    }

    private func importRoster(_ result: Result<URL, Error>) {
        switch result {
        case .failure(let error):
            rosterProblem = error.localizedDescription
        case .success(let url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            guard let data = try? Data(contentsOf: url) else {
                rosterProblem = "The file could not be read."
                return
            }
            let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
            useRoster(text)
        }
    }

    // MARK: Live results

    private var hubSection: some View {
        Section {
            if settingsStore.settings.hub == nil {
                Text("No results server is set up. Add one under Settings → Live results to have this race's results copied to your scoring computer as they are recorded.")
                    .foregroundStyle(.secondary)
            } else {
                Toggle("Send this race's results", isOn: Binding(
                    get: { store.race?.hubPaused != true },
                    set: { isOn in store.update { $0.hubPaused = isOn ? nil : true } }
                ))
                LabeledContent("Event code") {
                    TextField("event code", text: $codeText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                        .onSubmit { applyCode() }
                }
                if codeText != store.race?.eventCode(timeZone: .current) {
                    Button("Use this code") {
                        applyCode()
                    }
                }
                if let codeProblem {
                    Text(codeProblem).foregroundStyle(.red)
                }
                Text(hubStatusText).foregroundStyle(.secondary)
                LabeledContent("Data used by uploads", value: "about " + HubSync.formatData(hub.dataUsed))
            }
        } header: {
            Text("Live results")
        } footer: {
            Text("Every iPad at an event must use the same event code: that is how their results are combined on the results server. iPads on which the race was created with the same name on the same day already agree. The data figure is an estimate of what this iPad's uploads have used since the app was opened; only numbers and times are sent, never video or photos.")
        }
    }

    private func applyCode() {
        let code = HubPlanner.normalizedCode(codeText)
        guard HubPlanner.isValidCode(code) else {
            codeProblem = "Use 3 to 50 letters, digits and hyphens."
            return
        }
        codeProblem = nil
        codeText = code
        store.update { $0.hubCode = code }
    }

    private var hubStatusText: String {
        switch hub.status {
        case .off:
            return "No server set up."
        case .idle:
            return "Waiting."
        case .paused:
            return "This race is not being sent."
        case .waiting(let count):
            return count > 0 ? "\(count) results still to send." : "Sending."
        case .upToDate:
            return "Everything is on the server."
        case .failed(let message):
            return "Not sent yet, still trying. \(message)"
        }
    }

    // MARK: Clock correction

    private func clockSection(count: Int) -> some View {
        Section {
            Button("Correct them from the time server") {
                guard let fix = time.fix else { return }
                var corrected = 0
                store.update { corrected = $0.retime(with: fix) }
                retimeMessage = corrected == 0
                    ? "None could be corrected: the iPad has been restarted since they were recorded."
                    : "\(corrected) corrected."
            }
            .disabled(time.fix == nil)
            if let retimeMessage {
                Text(retimeMessage).foregroundStyle(.secondary)
            }
        } header: {
            Text("Clock")
        } footer: {
            Text("\(count) results were timed with the iPad's own clock because it was not synced. Once it has synced (and as long as it has not been restarted), their exact times can be worked out.")
        }
    }
}
#endif

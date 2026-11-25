#if canImport(UIKit)
import SwiftUI
import UIKit

/// Turns the results into a CSV file to share, save or copy.
struct ExportView: View {
    @EnvironmentObject private var store: RaceStore
    @EnvironmentObject private var settingsStore: SettingsStore
    @Environment(\.dismiss) private var dismiss

    @State private var format = ExportFormat.simple
    @State private var fileURL: URL?
    @State private var problem: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Contents", selection: $format) {
                        Text("Bib and time").tag(ExportFormat.simple)
                        Text("All details").tag(ExportFormat.detailed)
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(format == .simple
                         ? "One line per result, in finishing order: bib number, time of day and, if the race has a start time, elapsed time."
                         : "Adds names from the start list, UTC timestamps, how each time was taken, the clock accuracy, this iPad's station name and notes.")
                }

                Section {
                    if let fileURL {
                        ShareLink(item: fileURL) {
                            Label("Share or save the file", systemImage: "square.and.arrow.up")
                        }
                    }
                    Button {
                        UIPasteboard.general.string = csv
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy as text", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    }
                } footer: {
                    Text("Times of day are in this iPad's time zone (\(TimeZone.current.identifier)).")
                }

                Section("Preview") {
                    ScrollView(.horizontal) {
                        Text(preview)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: format) {
                copied = false
                writeFile()
            }
            // Results that come in while this is open belong in the file too.
            .onChange(of: store.race) { _, _ in
                writeFile()
            }
        }
    }

    private var csv: String {
        guard let race = store.race else { return "" }
        return CSVExport.csv(for: race, station: settingsStore.settings.station, format: format, timeZone: .current)
    }

    /// The first lines of the file.
    private var preview: String {
        let lines = csv.split(whereSeparator: { $0.isNewline })
        let shown = lines.prefix(12).joined(separator: "\n")
        return lines.count > 12 ? shown + "\n… \(lines.count - 12) more" : shown
    }

    private func writeFile() {
        guard let race = store.race else { return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Export", isDirectory: true)
        let name = CSVExport.fileName(for: race, station: settingsStore.settings.station, timeZone: .current)
        let url = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(csv.utf8).write(to: url, options: .atomic)
            fileURL = url
            problem = nil
        } catch {
            fileURL = nil
            problem = "The file could not be written: \(error.localizedDescription)"
        }
    }
}
#endif

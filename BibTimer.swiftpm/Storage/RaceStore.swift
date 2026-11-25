#if canImport(UIKit)
import Foundation
import Combine
import UIKit

/// Saved settings.
@MainActor
final class SettingsStore: ObservableObject {
    @Published var settings: AppSettings {
        didSet {
            if settings != oldValue { save() }
        }
    }

    private static let storageKey = "BibTimer.settings.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: SettingsStore.storageKey),
           let saved = try? JSONDecoder().decode(AppSettings.self, from: data) {
            settings = saved
        } else {
            settings = AppSettings()
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: SettingsStore.storageKey)
        }
    }
}

/// The races on this device. One race is open at a time; every change to it
/// is written to disk within half a second, so a crash or a flat battery
/// costs at most the last moment of a race.
///
/// Each race lives in its own folder in the app's Documents directory:
/// `Races/<id>/race.json` plus `Races/<id>/photos/`.
@MainActor
final class RaceStore: ObservableObject {
    struct Summary: Identifiable, Equatable {
        var id: UUID
        var name: String
        var createdAt: Date
        var count: Int
    }

    @Published private(set) var summaries: [Summary] = []
    @Published private(set) var race: Race?
    @Published private(set) var saveError: String?

    private var ledger = CrossingLedger()
    private var needsSave = false
    private var saveScheduled = false
    private let root: URL
    private let ioQueue = DispatchQueue(label: "bibtimer.store", qos: .utility)
    private let thumbnails = NSCache<NSString, UIImage>()

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("Races", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        summaries = RaceStore.loadSummaries(in: root)
    }

    // MARK: Races

    @discardableResult
    func createRace(named name: String) -> UUID {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var race = Race(name: trimmed.isEmpty ? "Race" : trimmed)
        // Fixed now, so that it does not change if the race is renamed or the
        // iPad moves to another time zone.
        race.hubCode = race.eventCode(timeZone: .current)
        write(race, synchronously: true)
        summaries.insert(Summary(id: race.id, name: race.name, createdAt: race.createdAt, count: 0), at: 0)
        return race.id
    }

    func open(_ id: UUID) {
        guard race?.id != id else { return }
        flush()
        ledger.reset()
        race = RaceStore.load(RaceStore.file(for: id, in: root))
    }

    func close() {
        flush()
        ledger.reset()
        race = nil
    }

    func deleteRace(_ id: UUID) {
        if race?.id == id {
            needsSave = false
            race = nil
        }
        let directory = RaceStore.directory(for: id, in: root)
        ioQueue.async {
            try? FileManager.default.removeItem(at: directory)
        }
        summaries.removeAll { $0.id == id }
    }

    // MARK: Changes to the open race

    /// Applies a change to the open race and schedules a save.
    func update(_ change: (inout Race) -> Void) {
        guard var changed = race else { return }
        change(&changed)
        guard changed != race else { return }
        commit(changed)
    }

    /// Records what the camera saw, subject to the repeat rule.
    func record(_ sightings: [BibSighting], rule: RepeatRule) {
        guard var changed = race else { return }
        var dirty = false
        for sighting in sightings {
            switch ledger.apply(sighting.report, to: &changed.crossings, rule: rule) {
            case .added(let id):
                dirty = true
                if let photo = sighting.photo, let index = changed.crossings.firstIndex(where: { $0.id == id }) {
                    let name = id.uuidString + ".jpg"
                    changed.crossings[index].photo = name
                    savePhoto(photo, named: name, raceID: changed.id)
                }
            case .updated:
                dirty = true
            case .removed(let id):
                dirty = true
                removePhoto(named: id.uuidString + ".jpg", raceID: changed.id)
            case .none:
                break
            }
        }
        if dirty { commit(changed) }
    }

    /// Adds a crossing without a bib number, to be filled in afterwards.
    @discardableResult
    func addManualMark(time: Date, clock: ClockStamp) -> UUID? {
        guard race != nil else { return nil }
        let crossing = Crossing.manual(bib: "", time: time, clock: clock)
        update { $0.crossings.append(crossing) }
        return crossing.id
    }

    /// Sets a crossing's bib by hand. The camera's reading is kept alongside.
    func setBib(_ text: String, for id: UUID) {
        let bib = BibFilter.canonical(text) ?? ""
        update { race in
            guard let index = race.crossings.firstIndex(where: { $0.id == id }), race.crossings[index].bib != bib else { return }
            if race.crossings[index].source == .camera, race.crossings[index].detectedBib == nil {
                race.crossings[index].detectedBib = race.crossings[index].bib
            }
            race.crossings[index].bib = bib
        }
    }

    func setNote(_ note: String, for id: UUID) {
        update { race in
            guard let index = race.crossings.firstIndex(where: { $0.id == id }) else { return }
            race.crossings[index].note = note
        }
    }

    func deleteCrossing(_ id: UUID) {
        guard let raceID = race?.id else { return }
        update { $0.crossings.removeAll { $0.id == id } }
        removePhoto(named: id.uuidString + ".jpg", raceID: raceID)
    }

    func deleteAllCrossings() {
        guard let raceID = race?.id else { return }
        ledger.reset()
        update { $0.crossings.removeAll() }
        thumbnails.removeAllObjects()
        let photos = RaceStore.photosDirectory(for: raceID, in: root)
        ioQueue.async {
            try? FileManager.default.removeItem(at: photos)
        }
    }

    // MARK: Photos

    func photoURL(for crossing: Crossing) -> URL? {
        guard let race, let name = crossing.photo else { return nil }
        return RaceStore.photosDirectory(for: race.id, in: root).appendingPathComponent(name)
    }

    func thumbnail(for crossing: Crossing) -> UIImage? {
        guard let name = crossing.photo else { return nil }
        if let cached = thumbnails.object(forKey: name as NSString) { return cached }
        guard let url = photoURL(for: crossing), let image = UIImage(contentsOfFile: url.path) else { return nil }
        thumbnails.setObject(image, forKey: name as NSString)
        return image
    }

    private func savePhoto(_ data: Data, named name: String, raceID: UUID) {
        if let image = UIImage(data: data) {
            thumbnails.setObject(image, forKey: name as NSString)
        }
        let directory = RaceStore.photosDirectory(for: raceID, in: root)
        ioQueue.async {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: directory.appendingPathComponent(name), options: .atomic)
        }
    }

    private func removePhoto(named name: String, raceID: UUID) {
        thumbnails.removeObject(forKey: name as NSString)
        let url = RaceStore.photosDirectory(for: raceID, in: root).appendingPathComponent(name)
        ioQueue.async {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: Saving

    private func commit(_ changed: Race) {
        race = changed
        if let index = summaries.firstIndex(where: { $0.id == changed.id }) {
            let summary = Summary(id: changed.id, name: changed.name, createdAt: changed.createdAt, count: changed.crossings.count)
            if summaries[index] != summary { summaries[index] = summary }
        }
        needsSave = true
        guard !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            MainActor.assumeIsolated {
                self?.saveScheduled = false
                self?.flush()
            }
        }
    }

    /// Writes any unsaved changes now. Pass `synchronously` when the app is
    /// about to be suspended.
    func flush(synchronously: Bool = false) {
        guard needsSave, let race else { return }
        needsSave = false
        write(race, synchronously: synchronously)
    }

    private func write(_ race: Race, synchronously: Bool) {
        let data: Data
        do {
            data = try RaceStore.makeEncoder().encode(race)
        } catch {
            saveError = error.localizedDescription
            return
        }
        let directory = RaceStore.directory(for: race.id, in: root)
        let file = RaceStore.file(for: race.id, in: root)
        let work: @Sendable () -> Void = { [weak self] in
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: file, options: .atomic)
                onMain { self?.saveError = nil }
            } catch {
                let message = error.localizedDescription
                onMain { self?.saveError = message }
            }
        }
        if synchronously {
            ioQueue.sync(execute: work)
        } else {
            ioQueue.async(execute: work)
        }
    }

    // MARK: Files

    private static func directory(for id: UUID, in root: URL) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    private static func file(for id: UUID, in root: URL) -> URL {
        directory(for: id, in: root).appendingPathComponent("race.json")
    }

    private static func photosDirectory(for id: UUID, in root: URL) -> URL {
        directory(for: id, in: root).appendingPathComponent("photos", isDirectory: true)
    }

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func load(_ file: URL) -> Race? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(Race.self, from: data)
    }

    private static func loadSummaries(in root: URL) -> [Summary] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        var summaries: [Summary] = []
        for folder in folders {
            guard let id = UUID(uuidString: folder.lastPathComponent),
                  let race = load(file(for: id, in: root)) else { continue }
            summaries.append(Summary(id: race.id, name: race.name, createdAt: race.createdAt, count: race.crossings.count))
        }
        return summaries.sorted { $0.createdAt > $1.createdAt }
    }
}
#endif

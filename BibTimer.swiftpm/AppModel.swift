#if canImport(UIKit)
import Combine
import Foundation

/// Creates the app's long-lived objects and wires them together.
@MainActor
final class AppModel: ObservableObject {
    let settings: SettingsStore
    let clock: RaceClock
    let time: TimeService
    let store: RaceStore
    let capture: CaptureCoordinator
    let hub: HubSync

    private var subscriptions = Set<AnyCancellable>()

    init() {
        let settings = SettingsStore()
        let clock = RaceClock()
        let time = TimeService(clock: clock, servers: settings.settings.cleanedServers)
        let store = RaceStore()
        let capture = CaptureCoordinator(clock: clock)
        let hub = HubSync()
        self.settings = settings
        self.clock = clock
        self.time = time
        self.store = store
        self.capture = capture
        self.hub = hub

        // What the camera records goes into the open race.
        capture.sightingHandler = { sightings, raceID in
            store.record(sightings, for: raceID, rule: settings.settings.repeatRule)
        }

        // The analysis follows the settings and the open race's start list.
        settings.$settings
            .combineLatest(store.$race.map { $0?.acceptedBibs }.removeDuplicates())
            .sink { newSettings, roster in
                capture.configure(settings: newSettings, roster: roster)
                time.setServers(newSettings.cleanedServers)
            }
            .store(in: &subscriptions)

        // Results are copied to the results server, if one is set up. It only
        // needs to hear about the few settings that concern it, not about
        // every step of a slider.
        settings.$settings
            .map { HubSync.Config($0) }
            .removeDuplicates()
            .sink { config in
                hub.update(config: config)
            }
            .store(in: &subscriptions)
        store.$race
            .sink { race in
                hub.update(race: race)
            }
            .store(in: &subscriptions)

        time.start()
        hub.start()
    }
}
#endif

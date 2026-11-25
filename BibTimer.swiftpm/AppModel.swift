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
        capture.sightingHandler = { sightings in
            store.record(sightings, rule: settings.settings.repeatRule)
        }

        // The analysis follows the settings and the open race's start list.
        settings.$settings
            .combineLatest(store.$race.map { $0?.acceptedBibs }.removeDuplicates())
            .sink { newSettings, roster in
                capture.configure(settings: newSettings, roster: roster)
                time.setServers(newSettings.cleanedServers)
            }
            .store(in: &subscriptions)

        // Results are copied to the results server, if one is set up.
        settings.$settings
            .combineLatest(store.$race)
            .sink { newSettings, race in
                hub.update(race: race, settings: newSettings)
            }
            .store(in: &subscriptions)

        time.start()
        hub.start()
    }
}
#endif

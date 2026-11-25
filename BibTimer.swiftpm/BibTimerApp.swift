import SwiftUI

@main
struct BibTimerApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model.settings)
                .environmentObject(model.time)
                .environmentObject(model.store)
                .environmentObject(model.capture)
        }
    }
}

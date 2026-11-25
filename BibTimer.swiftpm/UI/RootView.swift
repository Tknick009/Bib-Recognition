#if canImport(UIKit)
import SwiftUI

/// The list of races.
struct RootView: View {
    @EnvironmentObject private var store: RaceStore
    @EnvironmentObject private var time: TimeService
    @Environment(\.scenePhase) private var scenePhase

    @State private var path: [UUID] = []
    @State private var namingRace = false
    @State private var newName = ""
    @State private var raceToDelete: RaceStore.Summary?
    @State private var confirmingDelete = false
    @State private var activeSheet: RootSheet?

    enum RootSheet: String, Identifiable {
        case settings
        case sync

        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(store.summaries) { summary in
                    NavigationLink(value: summary.id) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(summary.name).font(.headline)
                            Text("\(TimeFormat.localDate(summary.createdAt, timeZone: .current)) · \(summary.count) results")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                    .swipeActions(edge: .trailing) {
                        Button {
                            raceToDelete = summary
                            confirmingDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .tint(.red)
                    }
                }
            }
            .overlay {
                if store.summaries.isEmpty {
                    ContentUnavailableView {
                        Label("No races yet", systemImage: "flag.checkered")
                    } description: {
                        Text("Create a race, point the iPad at the finish and press Record.")
                    } actions: {
                        Button("New race") { namingRace = true }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Bib Timer")
            .navigationDestination(for: UUID.self) { id in
                RaceView(raceID: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        activeSheet = .sync
                    } label: {
                        SyncChip()
                    }
                    .buttonStyle(.plain)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        activeSheet = .settings
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    Button {
                        namingRace = true
                    } label: {
                        Label("New race", systemImage: "plus")
                    }
                }
            }
            .alert("New race", isPresented: $namingRace) {
                TextField("Name", text: $newName)
                Button("Create") {
                    let id = store.createRace(named: newName)
                    newName = ""
                    path = [id]
                }
                Button("Cancel", role: .cancel) {
                    newName = ""
                }
            } message: {
                Text("For example the event and the distance.")
            }
            .alert("Delete this race?", isPresented: $confirmingDelete, presenting: raceToDelete) { summary in
                Button("Delete", role: .destructive) {
                    store.deleteRace(summary.id)
                }
                Button("Cancel", role: .cancel) {}
            } message: { summary in
                Text("“\(summary.name)” and its \(summary.count) results will be removed from this iPad.")
            }
            .sheet(item: $activeSheet) { sheet in
                switch sheet {
                case .settings: SettingsView()
                case .sync: SyncDetailView()
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                // Coming back to the app: check the clock straight away.
                Task { await time.sync() }
            }
        }
    }
}
#endif

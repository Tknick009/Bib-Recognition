// swift-tools-version: 5.9
import PackageDescription

// This manifest is for testing and continuous integration only. To build and
// run the app, open the BibTimer.swiftpm folder instead (see README.md).
//
// It compiles the app's sources — everything in BibTimer.swiftpm except the
// app entry point — as a library, so that
//   • `swift test` runs the unit tests (on Linux and macOS), and
//   • `xcodebuild` can compile every source file of the app for iOS.
let package = Package(
    name: "BibTimerKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BibTimerKit", targets: ["BibTimerKit"]),
    ],
    targets: [
        .target(
            name: "BibTimerKit",
            path: "BibTimer.swiftpm",
            exclude: ["Package.swift", "BibTimerApp.swift"]
        ),
        .testTarget(
            name: "BibTimerKitTests",
            dependencies: ["BibTimerKit"],
            path: "Tests/BibTimerKitTests"
        ),
    ]
)

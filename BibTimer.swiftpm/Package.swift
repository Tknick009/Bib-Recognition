// swift-tools-version: 5.9

// Bib Timer — a Swift Playgrounds app project.
//
// Open this folder (BibTimer.swiftpm) with Swift Playgrounds on an iPad, or
// with Xcode on a Mac, and press Run. See README.md in the repository root.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "BibTimer",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "BibTimer",
            targets: ["AppModule"],
            bundleIdentifier: "io.github.tknick009.BibTimer",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .running),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            capabilities: [
                .camera(purposeString: "The camera reads runners' bib numbers as they pass."),
                .localNetwork(purposeString: "Used only if you choose a time server on your own network.")
            ],
            appCategory: .sports
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)

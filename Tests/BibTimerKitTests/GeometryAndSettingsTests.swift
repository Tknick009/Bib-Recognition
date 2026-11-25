import XCTest
@testable import BibTimerKit

final class GeometryTests: XCTestCase {
    func testRectFromCornersInAnyOrder() {
        let rect = NormRect(corner: NormPoint(x: 0.8, y: 0.2), corner: NormPoint(x: 0.3, y: 0.6))
        XCTAssertEqual(rect.x, 0.3, accuracy: 1e-12)
        XCTAssertEqual(rect.y, 0.2, accuracy: 1e-12)
        XCTAssertEqual(rect.width, 0.5, accuracy: 1e-12)
        XCTAssertEqual(rect.height, 0.4, accuracy: 1e-12)
        XCTAssertEqual(rect.center.x, 0.55, accuracy: 1e-12)
        XCTAssertEqual(rect.center.y, 0.4, accuracy: 1e-12)
    }

    func testClamping() {
        let rect = NormRect(x: -0.2, y: 0.5, width: 0.5, height: 0.8).clamped()
        XCTAssertEqual(rect.x, 0, accuracy: 1e-12)
        XCTAssertEqual(rect.width, 0.3, accuracy: 1e-12)
        XCTAssertEqual(rect.y, 0.5, accuracy: 1e-12)
        XCTAssertEqual(rect.height, 0.5, accuracy: 1e-12)
        XCTAssertEqual(NormPoint(x: 1.4, y: -3).clamped(), NormPoint(x: 1, y: 0))
    }

    func testVisionBoxInTheFullFrame() {
        // Vision measures from the bottom-left corner.
        let box = NormRect.fromVision(x: 0.1, y: 0.2, width: 0.3, height: 0.1, regionOfInterest: .full)
        XCTAssertEqual(box.x, 0.1, accuracy: 1e-12)
        XCTAssertEqual(box.y, 0.7, accuracy: 1e-12)
        XCTAssertEqual(box.width, 0.3, accuracy: 1e-12)
        XCTAssertEqual(box.height, 0.1, accuracy: 1e-12)
    }

    func testVisionBoxInsideARegionOfInterest() {
        // The region spans x 0.25…0.75 and y 0.5…0.9 (from the top).
        let region = NormRect(x: 0.25, y: 0.5, width: 0.5, height: 0.4)
        let vision = region.visionRegion
        XCTAssertEqual(vision.x, 0.25, accuracy: 1e-12)
        XCTAssertEqual(vision.y, 0.1, accuracy: 1e-12)
        XCTAssertEqual(vision.width, 0.5, accuracy: 1e-12)
        XCTAssertEqual(vision.height, 0.4, accuracy: 1e-12)

        // A box whose bottom edge is halfway up the region.
        let box = NormRect.fromVision(x: 0.5, y: 0.5, width: 0.2, height: 0.25, regionOfInterest: region)
        XCTAssertEqual(box.x, 0.5, accuracy: 1e-12)
        XCTAssertEqual(box.y, 0.6, accuracy: 1e-12)
        XCTAssertEqual(box.width, 0.1, accuracy: 1e-12)
        XCTAssertEqual(box.height, 0.1, accuracy: 1e-12)
    }

    func testFinishLineSides() {
        let level = FinishLine(a: NormPoint(x: 0, y: 0.6), b: NormPoint(x: 1, y: 0.6), reversed: false)
        XCTAssertLessThan(level.side(of: NormPoint(x: 0.3, y: 0.2)), 0)
        XCTAssertGreaterThan(level.side(of: NormPoint(x: 0.9, y: 0.8)), 0)
        XCTAssertEqual(level.side(of: NormPoint(x: 0.5, y: 0.7)), 0.1, accuracy: 1e-12)
        XCTAssertEqual(level.normal, NormPoint(x: 0, y: 1))

        var flipped = level
        flipped.reversed = true
        XCTAssertGreaterThan(flipped.side(of: NormPoint(x: 0.3, y: 0.2)), 0)
        XCTAssertLessThan(flipped.side(of: NormPoint(x: 0.9, y: 0.8)), 0)

        // A slanted line through (0, 0) and (1, 1): points below-left of it are positive.
        let slanted = FinishLine(a: NormPoint(x: 0, y: 0), b: NormPoint(x: 1, y: 1), reversed: false)
        XCTAssertGreaterThan(slanted.side(of: NormPoint(x: 0.2, y: 0.8)), 0)
        XCTAssertLessThan(slanted.side(of: NormPoint(x: 0.8, y: 0.2)), 0)
        XCTAssertEqual(slanted.side(of: NormPoint(x: 0.4, y: 0.4)), 0, accuracy: 1e-12)

        XCTAssertTrue(level.isUsable)
        XCTAssertFalse(FinishLine(a: NormPoint(x: 0.5, y: 0.5), b: NormPoint(x: 0.505, y: 0.5), reversed: false).isUsable)
    }

    func testViewMappingWhenFitting() {
        // A 16:9 frame letterboxed in a square view.
        let mapping = ViewMapping(imageWidth: 1920, imageHeight: 1080, viewWidth: 1000, viewHeight: 1000)
        XCTAssertEqual(mapping.viewX(0), 0, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewX(1), 1000, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewY(0), 218.75, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewY(1), 781.25, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewY(0.5), 500, accuracy: 1e-9)

        let point = mapping.normPoint(viewX: 250, viewY: 500)
        XCTAssertEqual(point.x, 0.25, accuracy: 1e-9)
        XCTAssertEqual(point.y, 0.5, accuracy: 1e-9)
    }

    func testViewMappingWhenFilling() {
        let mapping = ViewMapping(imageWidth: 1920, imageHeight: 1080, viewWidth: 1000, viewHeight: 1000, fill: true)
        XCTAssertEqual(mapping.viewY(0), 0, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewY(1), 1000, accuracy: 1e-9)
        XCTAssertEqual(mapping.viewX(0.5), 500, accuracy: 1e-9)
        XCTAssertLessThan(mapping.viewX(0), 0)
        let point = mapping.normPoint(viewX: mapping.viewX(0.3), viewY: mapping.viewY(0.9))
        XCTAssertEqual(point.x, 0.3, accuracy: 1e-9)
        XCTAssertEqual(point.y, 0.9, accuracy: 1e-9)
    }
}

final class SettingsTests: XCTestCase {
    func testMissingFieldsFallBackToDefaults() throws {
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data("{}".utf8))
        XCTAssertEqual(settings, AppSettings())
    }

    func testUnknownAndUnreadableFieldsAreTolerated() throws {
        let json = """
        {"station": "Start", "rules": {"maxDigits": 3}, "minSightings": "oops", "addedInAFutureVersion": 1}
        """
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.station, "Start")
        XCTAssertEqual(settings.rules.maxDigits, 3)
        XCTAssertEqual(settings.rules.minDigits, 1)
        XCTAssertEqual(settings.minSightings, 2)
        XCTAssertEqual(settings.ntpServers, AppSettings.defaultServers)
    }

    func testSettingsSurviveSavingAndLoading() throws {
        var settings = AppSettings()
        settings.station = "Split 5 km"
        settings.rules.minNumber = 100
        settings.rules.ignored = ["2026"]
        settings.timingMode = .lastSeen
        settings.line = FinishLine(a: NormPoint(x: 0.25, y: 0.5), b: NormPoint(x: 0.75, y: 0.75), reversed: true)
        settings.scanZone = NormRect(x: 0.125, y: 0.25, width: 0.5, height: 0.5)
        settings.repeatRule = RepeatRule(allowRepeats: true, minInterval: 45)
        settings.shutterLimit = 500

        let loaded = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(loaded, settings)
    }

    func testServerListHelpers() {
        XCTAssertTrue(AppSettings.hostAndPort("time.apple.com") == ("time.apple.com", 123))
        XCTAssertTrue(AppSettings.hostAndPort("192.168.1.5:1123") == ("192.168.1.5", 1123))
        XCTAssertTrue(AppSettings.hostAndPort("host:abc") == ("host:abc", 123))

        var settings = AppSettings()
        settings.ntpServers = [" Time.Apple.com ", "", "time.apple.com", "pool.ntp.org"]
        XCTAssertEqual(settings.cleanedServers, ["time.apple.com", "pool.ntp.org"])
    }

    func testDerivedValues() {
        var settings = AppSettings()
        settings.minSightings = 0
        settings.timingMode = .firstSeen
        XCTAssertEqual(settings.trackerConfig.minSightings, 1)
        XCTAssertEqual(settings.trackerConfig.mode, .firstSeen)
        XCTAssertEqual(settings.trackerConfig.line, settings.line)

        XCTAssertEqual(settings.effectiveScanZone, .full)
        settings.scanZone = NormRect(x: 0.25, y: 0.25, width: 0.02, height: 0.5)
        XCTAssertEqual(settings.effectiveScanZone, .full)
        settings.scanZone = NormRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5)
        XCTAssertEqual(settings.effectiveScanZone, NormRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5))
    }
}

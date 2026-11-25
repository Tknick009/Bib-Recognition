#if canImport(Vision) && canImport(CoreText)
import XCTest
import CoreGraphics
import CoreText
@testable import BibTimerKit

/// Runs the real text recognizer on pictures drawn for the purpose: white
/// "bibs" with black numbers on a plain background.
final class TextRecognizerTests: XCTestCase {
    private struct Bib {
        var text: String
        /// In pixels, measured from the top-left corner of the picture.
        var rect: CGRect
    }

    private let width = 1280
    private let height = 720

    private func picture(of bibs: [Bib]) throws -> CGImage {
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw XCTSkip("could not create a drawing context")
        }
        context.setFillColor(CGColor(red: 0.35, green: 0.45, blue: 0.40, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        for bib in bibs {
            // Core Graphics measures from the bottom-left corner.
            let rect = CGRect(x: bib.rect.minX, y: CGFloat(height) - bib.rect.maxY, width: bib.rect.width, height: bib.rect.height)
            context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            context.fill(rect)

            let font = CTFontCreateWithName("Helvetica-Bold" as CFString, rect.height * 0.62, nil)
            let attributes: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
            ]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: bib.text, attributes: attributes))
            let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
            context.textPosition = CGPoint(x: rect.midX - bounds.midX, y: rect.midY - bounds.midY)
            CTLineDraw(line, context)
        }

        guard let image = context.makeImage() else {
            throw XCTSkip("could not render the test picture")
        }
        return image
    }

    private let left = Bib(text: "1234", rect: CGRect(x: 180, y: 300, width: 300, height: 130))
    private let right = Bib(text: "87", rect: CGRect(x: 840, y: 140, width: 200, height: 130))

    private func assertFound(_ bib: Bib, in candidates: [TextCandidate], file: StaticString = #filePath, line: UInt = #line) {
        guard let found = candidates.first(where: { $0.text == bib.text }) else {
            XCTFail("did not read \(bib.text); read \(candidates.map(\.text))", file: file, line: line)
            return
        }
        // The number is centred on its bib.
        XCTAssertEqual(found.box.midX, Double(bib.rect.midX) / Double(width), accuracy: 0.03, file: file, line: line)
        XCTAssertEqual(found.box.midY, Double(bib.rect.midY) / Double(height), accuracy: 0.03, file: file, line: line)
        XCTAssertLessThan(found.box.height, Double(bib.rect.height) / Double(height), file: file, line: line)
        XCTAssertGreaterThan(found.box.height, 0.3 * Double(bib.rect.height) / Double(height), file: file, line: line)
        XCTAssertGreaterThanOrEqual(found.confidence, 0.4, file: file, line: line)
    }

    func testReadsNumbersAndLocatesThemInTheFrame() throws {
        let image = try picture(of: [left, right])
        let candidates = try TextRecognizer().candidates(in: image, options: RecognizerOptions())
        assertFound(left, in: candidates)
        assertFound(right, in: candidates)

        let bibs = BibFilter.detections(from: candidates, rules: BibRules(), roster: nil).map(\.bib)
        XCTAssertEqual(Set(bibs), ["1234", "87"])
    }

    func testScanZoneLimitsTheSearchButKeepsFrameCoordinates() throws {
        let image = try picture(of: [left, right])
        // Covers the left bib only.
        let zone = NormRect(x: 0.05, y: 0.25, width: 0.45, height: 0.55)
        let candidates = try TextRecognizer().candidates(in: image, options: RecognizerOptions(zone: zone))
        XCTAssertNil(candidates.first { $0.text == right.text })
        assertFound(left, in: candidates)
    }

    func testWordsOnOneLineGetTheirOwnBoxes() throws {
        let wide = Bib(text: "412 908", rect: CGRect(x: 240, y: 280, width: 800, height: 150))
        let image = try picture(of: [wide])
        let candidates = try TextRecognizer().candidates(in: image, options: RecognizerOptions())

        let first = try XCTUnwrap(candidates.first { $0.text == "412" }, "read \(candidates.map(\.text))")
        let second = try XCTUnwrap(candidates.first { $0.text == "908" }, "read \(candidates.map(\.text))")
        XCTAssertLessThan(first.box.maxX, second.box.minX + 0.02)
        XCTAssertLessThan(first.box.midX, 0.5)
        XCTAssertGreaterThan(second.box.midX, 0.5)
        // Both sit on the same line inside the bib.
        XCTAssertEqual(first.box.midY, second.box.midY, accuracy: 0.03)
        XCTAssertEqual(first.box.midY, 355.0 / 720.0, accuracy: 0.04)
    }

    func testAnEmptyPictureHasNoText() throws {
        let image = try picture(of: [])
        XCTAssertTrue(try TextRecognizer().candidates(in: image, options: RecognizerOptions()).isEmpty)
    }
}
#endif

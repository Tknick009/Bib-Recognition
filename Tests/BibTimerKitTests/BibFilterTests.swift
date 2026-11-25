import XCTest
@testable import BibTimerKit

final class BibFilterTests: XCTestCase {
    private func candidate(_ text: String, confidence: Double = 1, height: Double = 0.05) -> TextCandidate {
        TextCandidate(text: text, confidence: confidence, box: NormRect(x: 0.4, y: 0.4, width: 0.1, height: height))
    }

    func testAcceptsPlainNumbers() {
        let rules = BibRules()
        XCTAssertEqual(BibFilter.bib(from: "1234", rules: rules), "1234")
        XCTAssertEqual(BibFilter.bib(from: " 57 ", rules: rules), "57")
        XCTAssertEqual(BibFilter.bib(from: "#308", rules: rules), "308")
        XCTAssertEqual(BibFilter.bib(from: "|416|", rules: rules), "416")
        XCTAssertEqual(BibFilter.bib(from: "0042", rules: rules), "42")
    }

    func testRejectsTextThatIsNotABibNumber() {
        let rules = BibRules()
        for text in ["", "RUN", "5K", "10K", "12:34", "1,234", "A123", "0", "000", "123456", "3.5", "12 34"] {
            XCTAssertNil(BibFilter.bib(from: text, rules: rules), "\"\(text)\" should not be a bib")
        }
    }

    func testReadsOneLookalikeLetterAsADigit() {
        var rules = BibRules()
        XCTAssertEqual(BibFilter.bib(from: "1O4", rules: rules), "104")
        XCTAssertEqual(BibFilter.bib(from: "I23", rules: rules), "123")
        XCTAssertEqual(BibFilter.bib(from: "25S", rules: rules), "255")
        // Too little of it is really a number.
        XCTAssertNil(BibFilter.bib(from: "SOS", rules: rules))
        XCTAssertNil(BibFilter.bib(from: "O2", rules: rules))
        XCTAssertNil(BibFilter.bib(from: "l0S", rules: rules))

        rules.fixLookalikes = false
        XCTAssertNil(BibFilter.bib(from: "1O4", rules: rules))
        XCTAssertEqual(BibFilter.bib(from: "104", rules: rules), "104")
    }

    func testDigitCountAndNumberRange() {
        var rules = BibRules()
        rules.minDigits = 3
        rules.maxDigits = 3
        XCTAssertNil(BibFilter.bib(from: "42", rules: rules))
        XCTAssertNil(BibFilter.bib(from: "1234", rules: rules))
        XCTAssertEqual(BibFilter.bib(from: "123", rules: rules), "123")

        rules = BibRules()
        rules.minNumber = 100
        rules.maxNumber = 499
        XCTAssertNil(BibFilter.bib(from: "99", rules: rules))
        XCTAssertEqual(BibFilter.bib(from: "100", rules: rules), "100")
        XCTAssertEqual(BibFilter.bib(from: "499", rules: rules), "499")
        XCTAssertNil(BibFilter.bib(from: "500", rules: rules))
    }

    func testDetectionsApplyConfidenceSizeIgnoreListAndRoster() {
        var rules = BibRules()
        rules.ignored = ["2026"]
        let candidates = [
            candidate("1234"),
            candidate("77", confidence: 0.3),
            candidate("88", height: 0.01),
            candidate("2026"),
            candidate("RUN"),
            candidate("999"),
        ]

        let open = BibFilter.detections(from: candidates, rules: rules, roster: nil)
        XCTAssertEqual(open.map(\.bib), ["1234", "999"])
        XCTAssertEqual(open.first?.box, NormRect(x: 0.4, y: 0.4, width: 0.1, height: 0.05))
        XCTAssertEqual(open.first?.confidence, 1)

        let restricted = BibFilter.detections(from: candidates, rules: rules, roster: ["1234", "55"])
        XCTAssertEqual(restricted.map(\.bib), ["1234"])
    }

    func testCanonicalSpelling() {
        XCTAssertEqual(BibFilter.canonical("#007"), "7")
        XCTAssertEqual(BibFilter.canonical(" 12 "), "12")
        XCTAssertNil(BibFilter.canonical("12a"))
        XCTAssertNil(BibFilter.canonical(""))
        XCTAssertNil(BibFilter.canonical("0"))
    }
}

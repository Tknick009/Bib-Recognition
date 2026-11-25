import Foundation

/// A piece of text found in a video frame.
struct TextCandidate: Equatable {
    var text: String
    /// 0...1, as reported by the text recognizer.
    var confidence: Double
    var box: NormRect
}

/// A piece of text that passed the bib rules.
struct BibDetection: Equatable {
    var bib: String
    var confidence: Double
    var box: NormRect
}

/// What counts as a bib number.
struct BibRules: Codable, Equatable {
    var minDigits = 1
    var maxDigits = 5
    /// Optional range of valid numbers, e.g. 1...500.
    var minNumber: Int?
    var maxNumber: Int?
    /// Text the recognizer is less sure about than this is ignored.
    var minConfidence = 0.4
    /// Text smaller than this fraction of the frame height is ignored.
    var minTextHeight = 0.015
    /// Read a single look-alike letter (O, I, S, B, Z…) as its digit.
    var fixLookalikes = true
    /// Numbers that are never bibs at this event (the year on a banner, say).
    var ignored: [String] = []

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = BibRules()
        minDigits = container.value(.minDigits, default: defaults.minDigits)
        maxDigits = container.value(.maxDigits, default: defaults.maxDigits)
        minNumber = container.value(.minNumber, default: defaults.minNumber)
        maxNumber = container.value(.maxNumber, default: defaults.maxNumber)
        minConfidence = container.value(.minConfidence, default: defaults.minConfidence)
        minTextHeight = container.value(.minTextHeight, default: defaults.minTextHeight)
        fixLookalikes = container.value(.fixLookalikes, default: defaults.fixLookalikes)
        ignored = container.value(.ignored, default: defaults.ignored)
    }
}

extension KeyedDecodingContainer {
    /// Decodes a value, falling back to a default when the key is missing or
    /// holds something unreadable. Lets saved settings survive app updates
    /// that add or change fields.
    func value<T: Decodable>(_ key: Key, default fallback: T) -> T {
        guard let decoded = try? decodeIfPresent(T.self, forKey: key) else { return fallback }
        return decoded
    }
}

enum BibFilter {
    /// Letters that text recognition commonly reports in place of a digit.
    private static let lookalikes: [Character: Character] = [
        "O": "0", "o": "0", "D": "0", "Q": "0",
        "I": "1", "l": "1",
        "Z": "2", "z": "2",
        "S": "5", "s": "5",
        "B": "8",
    ]

    private static let digits: Set<Character> = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

    /// Stray marks around a number: a "#" prefix, or the edge of the bib read
    /// as a bar. Dropped rather than treated as part of the number.
    private static let edgePunctuation = CharacterSet(charactersIn: "#.,:;-_*'\"()[]{}<>/\\|!")

    /// Keeps the candidates that look like bib numbers.
    ///
    /// - Parameter roster: when given, only these numbers are accepted.
    static func detections(from candidates: [TextCandidate], rules: BibRules, roster: Set<String>?) -> [BibDetection] {
        let ignored = Set(rules.ignored.compactMap { canonical($0) })
        var result: [BibDetection] = []
        for candidate in candidates {
            guard candidate.confidence >= rules.minConfidence,
                  candidate.box.height >= rules.minTextHeight,
                  let bib = bib(from: candidate.text, rules: rules),
                  !ignored.contains(bib) else { continue }
            if let roster, !roster.contains(bib) { continue }
            result.append(BibDetection(bib: bib, confidence: candidate.confidence, box: candidate.box))
        }
        return result
    }

    /// The bib number a piece of recognized text stands for, if any.
    static func bib(from text: String, rules: BibRules) -> String? {
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: edgePunctuation)
        guard !token.isEmpty, token.count <= 12 else { return nil }

        var number = ""
        var realDigits = 0
        var substitutions = 0
        for character in token {
            if digits.contains(character) {
                number.append(character)
                realDigits += 1
            } else if rules.fixLookalikes, let digit = lookalikes[character] {
                number.append(digit)
                substitutions += 1
            } else {
                return nil
            }
        }
        // One misread character in an otherwise numeric string is believable;
        // more than that is more likely to be a word.
        if substitutions > 0 && (substitutions > 1 || realDigits < 2) { return nil }

        guard let bib = stripLeadingZeros(number),
              bib.count >= rules.minDigits, bib.count <= rules.maxDigits,
              let value = Int(bib) else { return nil }
        if let minNumber = rules.minNumber, value < minNumber { return nil }
        if let maxNumber = rules.maxNumber, value > maxNumber { return nil }
        return bib
    }

    /// The standard spelling of a bib number that was typed or imported:
    /// digits only, without a leading "#" or leading zeros.
    static func canonical(_ text: String) -> String? {
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: edgePunctuation)
        guard !token.isEmpty, token.count <= 12, token.allSatisfy({ digits.contains($0) }) else { return nil }
        return stripLeadingZeros(token)
    }

    private static func stripLeadingZeros(_ number: String) -> String? {
        let stripped = String(number.drop(while: { $0 == "0" }))
        return stripped.isEmpty ? nil : stripped
    }
}

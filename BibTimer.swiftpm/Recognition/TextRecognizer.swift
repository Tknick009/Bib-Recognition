#if canImport(Vision)
import Foundation
import CoreGraphics
import CoreVideo
import Vision

struct RecognizerOptions: Equatable {
    /// The part of the frame to search.
    var zone = NormRect.full
    /// Smallest text to look for, as a fraction of the frame height. Smaller
    /// values find bibs further away but take longer.
    var minimumTextHeight = 0.015
    /// The accurate recognizer reads scene text far better than the fast one.
    var accurate = true
}

/// Finds text in video frames with Apple's on-device text recognition.
///
/// Frames must be upright. Results are in frame coordinates (see `NormRect`),
/// one candidate per word, so a number printed next to other text gets a box
/// of its own.
final class TextRecognizer {
    private let request = VNRecognizeTextRequest()

    init() {
        // Bib numbers are not words: language correction would only "fix"
        // digits into letters.
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        request.automaticallyDetectsLanguage = false
    }

    func candidates(in pixelBuffer: CVPixelBuffer, options: RecognizerOptions) throws -> [TextCandidate] {
        try perform(VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:]), options: options)
    }

    func candidates(in image: CGImage, options: RecognizerOptions) throws -> [TextCandidate] {
        try perform(VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]), options: options)
    }

    private func perform(_ handler: VNImageRequestHandler, options: RecognizerOptions) throws -> [TextCandidate] {
        let zone = options.zone.clamped()
        let usesZone = zone != .full && zone.width >= 0.05 && zone.height >= 0.05
        let region = usesZone ? zone : NormRect.full
        let visionRegion = region.visionRegion

        request.recognitionLevel = options.accurate ? .accurate : .fast
        request.minimumTextHeight = Float(min(max(options.minimumTextHeight, 0), 0.5))
        request.regionOfInterest = CGRect(x: visionRegion.x, y: visionRegion.y, width: visionRegion.width, height: visionRegion.height)

        try handler.perform([request])

        var candidates: [TextCandidate] = []
        for observation in request.results ?? [] {
            guard let text = observation.topCandidates(1).first else { continue }
            let string = text.string
            let confidence = Double(text.confidence)
            let words = string.split(whereSeparator: { $0.isWhitespace })
            if words.count > 1 {
                for word in words {
                    // Each word's own box, when Vision can provide it.
                    let wordBox = (try? text.boundingBox(for: word.startIndex..<word.endIndex))?.boundingBox
                    candidates.append(TextCandidate(
                        text: String(word),
                        confidence: confidence,
                        box: TextRecognizer.frameRect(wordBox ?? observation.boundingBox, region: region)
                    ))
                }
            } else {
                candidates.append(TextCandidate(
                    text: string,
                    confidence: confidence,
                    box: TextRecognizer.frameRect(observation.boundingBox, region: region)
                ))
            }
        }
        return candidates
    }

    private static func frameRect(_ box: CGRect, region: NormRect) -> NormRect {
        NormRect.fromVision(
            x: Double(box.minX), y: Double(box.minY),
            width: Double(box.width), height: Double(box.height),
            regionOfInterest: region
        )
    }
}
#endif

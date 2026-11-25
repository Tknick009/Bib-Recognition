import Foundation

/// A point in normalized image coordinates: `(0, 0)` is the top-left corner of
/// the upright video frame and `(1, 1)` its bottom-right corner.
struct NormPoint: Codable, Hashable {
    var x: Double
    var y: Double

    func clamped() -> NormPoint {
        NormPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    }
}

/// A rectangle in normalized image coordinates (origin top-left, y pointing down).
struct NormRect: Codable, Hashable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    static let full = NormRect(x: 0, y: 0, width: 1, height: 1)

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    /// The rectangle spanned by two opposite corners, given in any order.
    init(corner a: NormPoint, corner b: NormPoint) {
        self.init(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    var minX: Double { x }
    var minY: Double { y }
    var maxX: Double { x + width }
    var maxY: Double { y + height }
    var midX: Double { x + width / 2 }
    var midY: Double { y + height / 2 }
    var center: NormPoint { NormPoint(x: midX, y: midY) }

    /// The part of the rectangle that lies inside the frame.
    func clamped() -> NormRect {
        if minX >= 0, minY >= 0, maxX <= 1, maxY <= 1, width >= 0, height >= 0 {
            return self
        }
        let left = min(max(minX, 0), 1)
        let right = min(max(maxX, 0), 1)
        let top = min(max(minY, 0), 1)
        let bottom = min(max(maxY, 0), 1)
        return NormRect(x: left, y: top, width: max(right - left, 0), height: max(bottom - top, 0))
    }
}

// MARK: - Vision coordinates

extension NormRect {
    /// This rectangle as a Vision region of interest: normalized, with the
    /// origin in the bottom-left corner of the image.
    var visionRegion: (x: Double, y: Double, width: Double, height: Double) {
        (x, 1 - maxY, width, height)
    }

    /// Converts a bounding box reported by Vision into frame coordinates.
    ///
    /// Vision reports boxes normalized to the region of interest it was asked
    /// to scan, with the origin in the bottom-left corner of that region.
    static func fromVision(x: Double, y: Double, width: Double, height: Double, regionOfInterest region: NormRect) -> NormRect {
        let boxWidth = width * region.width
        let boxHeight = height * region.height
        let left = region.x + x * region.width
        // Distance of the box's bottom edge from the bottom of the full frame.
        let bottom = (1 - region.maxY) + y * region.height
        return NormRect(x: left, y: 1 - bottom - boxHeight, width: boxWidth, height: boxHeight)
    }
}

// MARK: - Finish line

/// A virtual finish line drawn across the video frame.
///
/// The two points only fix where the line lies; it extends across the whole
/// frame. Runners are expected to move from the negative side to the positive
/// side (see `side(of:)`).
struct FinishLine: Codable, Hashable {
    var a: NormPoint
    var b: NormPoint
    /// Swaps which side of the line counts as "finished".
    var reversed: Bool

    /// A level line a little below the middle of the frame. With the camera
    /// above the runners and looking down the course, bibs move down the frame
    /// as runners approach, so the finished side is below the line.
    static let standard = FinishLine(a: NormPoint(x: 0.08, y: 0.62), b: NormPoint(x: 0.92, y: 0.62), reversed: false)

    /// Negative while a point is on the approach side of the line, positive
    /// once it is past it. The magnitude grows linearly with the distance from
    /// the line, so crossing times can be interpolated.
    func side(of point: NormPoint) -> Double {
        let normal = self.normal
        return normal.x * (point.x - a.x) + normal.y * (point.y - a.y)
    }

    /// A vector perpendicular to the line that points toward the finished side.
    var normal: NormPoint {
        let dx = b.x - a.x
        let dy = b.y - a.y
        return reversed ? NormPoint(x: dy, y: -dx) : NormPoint(x: -dy, y: dx)
    }

    /// False when the two points are too close together to define a direction.
    var isUsable: Bool {
        let dx = b.x - a.x
        let dy = b.y - a.y
        return dx * dx + dy * dy > 0.0004
    }
}

// MARK: - View mapping

/// Maps normalized image coordinates to the points of a view that shows the
/// image scaled to fit (letterboxed) or scaled to fill (cropped).
struct ViewMapping: Equatable {
    let imageWidth: Double
    let imageHeight: Double
    let scale: Double
    let offsetX: Double
    let offsetY: Double

    init(imageWidth: Double, imageHeight: Double, viewWidth: Double, viewHeight: Double, fill: Bool = false) {
        let width = max(imageWidth, 1)
        let height = max(imageHeight, 1)
        let scaleX = viewWidth / width
        let scaleY = viewHeight / height
        let scale = fill ? max(scaleX, scaleY) : min(scaleX, scaleY)
        self.imageWidth = width
        self.imageHeight = height
        self.scale = scale
        self.offsetX = (viewWidth - width * scale) / 2
        self.offsetY = (viewHeight - height * scale) / 2
    }

    func viewX(_ x: Double) -> Double { offsetX + x * imageWidth * scale }
    func viewY(_ y: Double) -> Double { offsetY + y * imageHeight * scale }

    func normPoint(viewX: Double, viewY: Double) -> NormPoint {
        guard scale > 0 else { return NormPoint(x: 0, y: 0) }
        return NormPoint(
            x: (viewX - offsetX) / (imageWidth * scale),
            y: (viewY - offsetY) / (imageHeight * scale)
        )
    }
}

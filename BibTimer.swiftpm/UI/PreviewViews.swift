#if canImport(UIKit)
import AVFoundation
import SwiftUI
import UIKit

extension ViewMapping {
    init(frameSize: CGSize, viewSize: CGSize) {
        self.init(imageWidth: Double(frameSize.width), imageHeight: Double(frameSize.height),
                  viewWidth: Double(viewSize.width), viewHeight: Double(viewSize.height))
    }

    func point(_ point: NormPoint) -> CGPoint {
        CGPoint(x: viewX(point.x), y: viewY(point.y))
    }

    func rect(_ rect: NormRect) -> CGRect {
        CGRect(x: viewX(rect.minX), y: viewY(rect.minY),
               width: rect.width * imageWidth * scale, height: rect.height * imageHeight * scale)
    }

    /// Where the video frame sits inside the view.
    var imageFrame: CGRect {
        rect(.full)
    }
}

// MARK: - Live video

/// Shows the camera's preview layer.
struct CameraPreview: UIViewRepresentable {
    let layer: AVCaptureVideoPreviewLayer

    func makeUIView(context: Context) -> PreviewHostView {
        let view = PreviewHostView()
        view.backgroundColor = .black
        view.host(layer)
        return view
    }

    func updateUIView(_ view: PreviewHostView, context: Context) {
        view.host(layer)
    }
}

final class PreviewHostView: UIView {
    private var hosted: CALayer?

    func host(_ newLayer: CALayer) {
        if newLayer.superlayer !== layer {
            newLayer.removeFromSuperlayer()
            layer.addSublayer(newLayer)
        }
        hosted = newLayer
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The layer may have moved on to another view since.
        guard let hosted, hosted.superlayer === layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        hosted.frame = bounds
        CATransaction.commit()
    }
}

// MARK: - Drawing on top of the video

/// Outlines the bibs being read and shows the scan zone and finish line.
struct DetectionOverlay: View {
    @ObservedObject var model: OverlayModel
    let settings: AppSettings
    let recordedBibs: Set<String>
    let isRecording: Bool

    var body: some View {
        Canvas { context, size in
            let mapping = ViewMapping(frameSize: model.frameSize, viewSize: size)
            let frame = mapping.imageFrame
            drawZone(in: context, mapping: mapping, frame: frame)
            if settings.timingMode == .line {
                drawLine(in: context, mapping: mapping, frame: frame)
            }
            for box in model.otherText {
                context.stroke(Path(mapping.rect(box)), with: .color(Color.white.opacity(0.6)), lineWidth: 1)
            }
            for item in model.overlays {
                drawBib(item, in: context, mapping: mapping)
            }
        }
        .allowsHitTesting(false)
    }

    private func drawZone(in context: GraphicsContext, mapping: ViewMapping, frame: CGRect) {
        let zone = settings.effectiveScanZone
        guard zone != .full else { return }
        let rect = mapping.rect(zone)
        var shade = Path(frame)
        shade.addRect(rect)
        context.fill(shade, with: .color(Color.black.opacity(0.45)), style: FillStyle(eoFill: true))
        context.stroke(Path(rect), with: .color(Color.cyan), style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
    }

    private func drawLine(in context: GraphicsContext, mapping: ViewMapping, frame: CGRect) {
        let line = settings.line
        guard line.isUsable else { return }
        let a = mapping.point(line.a)
        let b = mapping.point(line.b)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let length = max((dx * dx + dy * dy).squareRoot(), 1)
        let ux = dx / length
        let uy = dy / length
        let reach = frame.width + frame.height

        var clipped = context
        clipped.clip(to: Path(frame))

        var path = Path()
        path.move(to: CGPoint(x: a.x - ux * reach, y: a.y - uy * reach))
        path.addLine(to: CGPoint(x: b.x + ux * reach, y: b.y + uy * reach))
        clipped.stroke(path, with: .color(Color.black.opacity(0.5)), style: StrokeStyle(lineWidth: 6))
        clipped.stroke(path, with: .color(Color.orange), style: StrokeStyle(lineWidth: 3))

        // An arrow across the line, pointing the way runners cross it. In
        // the view the line's normal is (-uy, ux) or its opposite.
        let normal = line.normal
        let towardFinish = CGFloat(normal.x * mapping.imageHeight) * -uy + CGFloat(normal.y * mapping.imageWidth) * ux
        let sign: CGFloat = towardFinish >= 0 ? 1 : -1
        let nx = -uy * sign
        let ny = ux * sign
        let middle = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        let tail = CGPoint(x: middle.x - nx * 30, y: middle.y - ny * 30)
        let tip = CGPoint(x: middle.x + nx * 30, y: middle.y + ny * 30)
        var arrow = Path()
        arrow.move(to: tail)
        arrow.addLine(to: tip)
        arrow.move(to: CGPoint(x: tip.x - nx * 13 - ny * 9, y: tip.y - ny * 13 + nx * 9))
        arrow.addLine(to: tip)
        arrow.addLine(to: CGPoint(x: tip.x - nx * 13 + ny * 9, y: tip.y - ny * 13 - nx * 9))
        let style = StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round)
        clipped.stroke(arrow, with: .color(Color.orange), style: style)
    }

    private func drawBib(_ item: TrackOverlay, in context: GraphicsContext, mapping: ViewMapping) {
        let color: Color
        switch item.state {
        case .pending:
            color = .white
        case .tracking:
            color = .yellow
        case .timed:
            color = isRecording && recordedBibs.contains(item.bib) ? .green : .yellow
        }
        let rect = mapping.rect(item.box).insetBy(dx: -5, dy: -5)
        let outline = Path(roundedRect: rect, cornerRadius: 6)
        context.stroke(outline, with: .color(Color.black.opacity(0.6)), lineWidth: item.state == .pending ? 4 : 6)
        context.stroke(outline, with: .color(color), lineWidth: item.state == .pending ? 2 : 4)

        guard !item.bib.isEmpty else { return }
        let label = context.resolve(
            Text(item.bib)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundColor(.black)
        )
        let labelSize = label.measure(in: CGSize(width: 320, height: 80))
        let plate = CGRect(
            x: rect.midX - labelSize.width / 2 - 7,
            y: max(rect.minY - labelSize.height - 10, 0),
            width: labelSize.width + 14,
            height: labelSize.height + 6
        )
        context.fill(Path(roundedRect: plate, cornerRadius: 7), with: .color(color))
        context.draw(label, at: CGPoint(x: plate.midX, y: plate.midY), anchor: .center)
    }
}

/// Handles for moving the finish line and resizing the scan zone.
struct AdjustOverlay: View {
    @ObservedObject var model: OverlayModel
    @Binding var settings: AppSettings

    /// For each handle being dragged: where on the screen the drag started and
    /// where the handle's point was then. A drag that starts somewhere else is
    /// a new drag, even if the previous one never reported that it ended.
    @State private var drags: [Int: DragStart] = [:]

    private struct DragStart {
        var screen: CGPoint
        var origin: NormPoint
    }

    private static let minimumZoneSide = 0.15
    /// Handles are drawn at least this far inside the view, so that one whose
    /// point lies on the very edge of the picture can still be grabbed.
    private static let edgeInset: CGFloat = 26

    var body: some View {
        GeometryReader { proxy in
            let mapping = ViewMapping(frameSize: model.frameSize, viewSize: proxy.size)
            let zone = settings.effectiveScanZone
            let topLeft = NormPoint(x: zone.minX, y: zone.minY)
            let bottomRight = NormPoint(x: zone.maxX, y: zone.maxY)
            let side = AdjustOverlay.minimumZoneSide
            ZStack {
                // A corner stops short of the opposite corner instead of
                // passing it.
                handle(0, at: topLeft, color: .cyan, mapping: mapping, viewSize: proxy.size) { point in
                    let x = min(point.x, bottomRight.x - side)
                    let y = min(point.y, bottomRight.y - side)
                    settings.scanZone = NormRect(x: x, y: y, width: bottomRight.x - x, height: bottomRight.y - y)
                }
                handle(1, at: bottomRight, color: .cyan, mapping: mapping, viewSize: proxy.size) { point in
                    let x = max(point.x, topLeft.x + side)
                    let y = max(point.y, topLeft.y + side)
                    settings.scanZone = NormRect(x: topLeft.x, y: topLeft.y, width: x - topLeft.x, height: y - topLeft.y)
                }
                if settings.timingMode == .line {
                    handle(2, at: settings.line.a, color: .orange, mapping: mapping, viewSize: proxy.size) { point in
                        setLine(a: point, b: settings.line.b)
                    }
                    handle(3, at: settings.line.b, color: .orange, mapping: mapping, viewSize: proxy.size) { point in
                        setLine(a: settings.line.a, b: point)
                    }
                }
            }
        }
    }

    private func setLine(a: NormPoint, b: NormPoint) {
        var line = settings.line
        line.a = a
        line.b = b
        guard line.isUsable else { return }
        settings.line = line
    }

    private func handle(_ id: Int, at point: NormPoint, color: Color, mapping: ViewMapping, viewSize: CGSize,
                        move: @escaping (NormPoint) -> Void) -> some View {
        let exact = mapping.point(point)
        let inset = AdjustOverlay.edgeInset
        let shown = CGPoint(
            x: min(max(exact.x, inset), max(viewSize.width - inset, inset)),
            y: min(max(exact.y, inset), max(viewSize.height - inset, inset))
        )
        return Circle()
            .fill(color)
            .frame(width: 30, height: 30)
            .overlay(Circle().stroke(Color.white, lineWidth: 3))
            .shadow(radius: 3)
            // A bigger target than the dot itself.
            .padding(12)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { value in
                        let start: DragStart
                        if let known = drags[id], known.screen == value.startLocation {
                            start = known
                        } else {
                            start = DragStart(screen: value.startLocation, origin: point)
                            drags[id] = start
                        }
                        // The point moves by as much as the finger has.
                        let from = mapping.point(start.origin)
                        let moved = mapping.normPoint(
                            viewX: Double(from.x + value.translation.width),
                            viewY: Double(from.y + value.translation.height)
                        )
                        move(moved.clamped())
                    }
                    .onEnded { _ in
                        drags[id] = nil
                    }
            )
            .position(shown)
    }
}
#endif

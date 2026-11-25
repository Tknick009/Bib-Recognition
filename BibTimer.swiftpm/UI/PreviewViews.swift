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

    /// Where each handle was when its drag began.
    @State private var dragOrigins: [Int: NormPoint] = [:]

    private static let minimumZoneSide = 0.15

    var body: some View {
        GeometryReader { proxy in
            let mapping = ViewMapping(frameSize: model.frameSize, viewSize: proxy.size)
            let zone = settings.effectiveScanZone
            let topLeft = NormPoint(x: zone.minX, y: zone.minY)
            let bottomRight = NormPoint(x: zone.maxX, y: zone.maxY)
            ZStack {
                handle(0, at: topLeft, color: .cyan, mapping: mapping) { point in
                    setZone(NormRect(corner: point, corner: bottomRight))
                }
                handle(1, at: bottomRight, color: .cyan, mapping: mapping) { point in
                    setZone(NormRect(corner: topLeft, corner: point))
                }
                if settings.timingMode == .line {
                    handle(2, at: settings.line.a, color: .orange, mapping: mapping) { point in
                        setLine(a: point, b: settings.line.b)
                    }
                    handle(3, at: settings.line.b, color: .orange, mapping: mapping) { point in
                        setLine(a: settings.line.a, b: point)
                    }
                }
            }
        }
    }

    private func setZone(_ zone: NormRect) {
        guard zone.width >= AdjustOverlay.minimumZoneSide, zone.height >= AdjustOverlay.minimumZoneSide else { return }
        settings.scanZone = zone
    }

    private func setLine(a: NormPoint, b: NormPoint) {
        var line = settings.line
        line.a = a
        line.b = b
        guard line.isUsable else { return }
        settings.line = line
    }

    private func handle(_ id: Int, at point: NormPoint, color: Color, mapping: ViewMapping,
                        move: @escaping (NormPoint) -> Void) -> some View {
        Circle()
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
                        let origin = dragOrigins[id] ?? point
                        if dragOrigins[id] == nil {
                            dragOrigins[id] = point
                        }
                        let start = mapping.point(origin)
                        let moved = mapping.normPoint(
                            viewX: Double(start.x + value.translation.width),
                            viewY: Double(start.y + value.translation.height)
                        )
                        move(moved.clamped())
                    }
                    .onEnded { _ in
                        dragOrigins[id] = nil
                    }
            )
            .position(mapping.point(point))
    }
}
#endif

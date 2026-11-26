// Places in the picture, as fractions of its width and height: (0, 0) is the
// top-left corner and (1, 1) the bottom-right. A box is { x, y, width, height }.

export const wholePicture = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function within(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

export function clampPoint(point) {
  return { x: within(point.x, 0, 1), y: within(point.y, 0, 1) };
}

/** The part of a box that lies inside the picture. */
export function clampBox(box) {
  const left = within(box.x, 0, 1);
  const top = within(box.y, 0, 1);
  const right = within(box.x + box.width, 0, 1);
  const bottom = within(box.y + box.height, 0, 1);
  return { x: left, y: top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

/**
 * A virtual finish line drawn across the picture: { a, b, reversed }.
 *
 * The two points only fix where the line lies; it extends across the whole
 * picture. Runners are expected to move from its negative side to its
 * positive side. The standard line is level, a little below the middle: with
 * the camera above the runners and looking back along the course, bibs move
 * down the picture as runners approach, so the finished side is below.
 */
export const standardLine = Object.freeze({ a: Object.freeze({ x: 0.08, y: 0.62 }), b: Object.freeze({ x: 0.92, y: 0.62 }), reversed: false });

/** A vector across the line that points toward the finished side. */
export function lineNormal(line) {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  return line.reversed ? { x: dy, y: -dx } : { x: -dy, y: dx };
}

/**
 * Negative while a point is on the approach side of the line, positive once
 * it is past. The size grows evenly with the distance from the line, which
 * is what lets a crossing time be worked out between two sightings.
 */
export function sideOfLine(line, point) {
  const normal = lineNormal(line);
  return normal.x * (point.x - line.a.x) + normal.y * (point.y - line.a.y);
}

/** False when the two points are too close together to give a direction. */
export function lineIsUsable(line) {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  return dx * dx + dy * dy > 0.0004;
}

/**
 * Where a picture sits in a view that shows all of it, scaled to fit, and
 * back: for drawing on top of the video and for reading touches.
 */
export function fitMapping(pictureWidth, pictureHeight, viewWidth, viewHeight) {
  const width = Math.max(pictureWidth, 1);
  const height = Math.max(pictureHeight, 1);
  const scale = Math.min(viewWidth / width, viewHeight / height);
  const offsetX = (viewWidth - width * scale) / 2;
  const offsetY = (viewHeight - height * scale) / 2;
  return {
    scale,
    viewX: (x) => offsetX + x * width * scale,
    viewY: (y) => offsetY + y * height * scale,
    toPicture: (viewX, viewY) => (scale > 0
      ? { x: (viewX - offsetX) / (width * scale), y: (viewY - offsetY) / (height * scale) }
      : { x: 0, y: 0 }),
  };
}

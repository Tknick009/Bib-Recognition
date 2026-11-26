// What is drawn on top of the camera's picture: the finish line, the part of
// the picture that is searched, and a box around every bib that is being
// followed. In "adjust" mode the line and the search area can be dragged.

import { clampBox, clampPoint, fitMapping, lineIsUsable, sideOfLine } from './lib/geometry.js';

const colours = {
  pending: '#fde047', // read, not yet believed
  tracking: '#fb923c', // believed, waiting for its moment
  timed: '#4ade80', // its time has been taken
};
const lineColour = '#38bdf8';
// Boxes are from the last picture that was looked at; after this long they
// say nothing about where the bibs are now. Long enough to last until the
// next look on a slow iPad.
const boxesLastFor = 1600;
// How near a touch has to be to a handle to take hold of it, in points.
const reach = 44;
const smallestZone = 0.12;

export class Overlay {
  #canvas;
  #context;
  #video;
  #settings;
  #onAdjust;
  #boxes = [];
  // When the picture the boxes come from was taken, and when they arrived.
  #boxesTaken = 0;
  #boxesAt = -Infinity;
  #queued = false;
  #fade = null;
  #drag = null;
  #adjusting = false;

  /**
   * @param {HTMLCanvasElement} canvas lies exactly over the video
   * @param {HTMLVideoElement} video
   * @param {object} options
   * @param {() => object} options.settings the page's settings (line, scanZone, timingMode, cameraDelay)
   * @param {(finished: boolean) => void} options.onAdjust called while and after something is dragged
   */
  constructor(canvas, video, { settings, onAdjust = () => {} }) {
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    this.#video = video;
    this.#settings = settings;
    this.#onAdjust = onAdjust;

    canvas.addEventListener('pointerdown', (event) => this.#down(event));
    canvas.addEventListener('pointermove', (event) => this.#moved(event));
    canvas.addEventListener('pointerup', (event) => this.#up(event));
    canvas.addEventListener('pointercancel', (event) => this.#up(event));
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.invalidate()).observe(canvas);
    window.addEventListener('resize', () => this.invalidate());
    video.addEventListener('loadedmetadata', () => this.invalidate());
    video.addEventListener('resize', () => this.invalidate());
  }

  get adjusting() {
    return this.#adjusting;
  }

  set adjusting(value) {
    this.#adjusting = value;
    this.#drag = null;
    this.#canvas.classList.toggle('adjusting', value);
    this.invalidate();
  }

  /**
   * The bibs found in the picture that was last looked at.
   *
   * @param {number} taken when that picture was taken, on the page's clock in milliseconds
   */
  show(boxes, taken) {
    this.#boxes = boxes;
    this.#boxesTaken = taken;
    this.#boxesAt = performance.now();
    clearTimeout(this.#fade);
    // Wiped when they are no longer true, unless newer ones arrive first.
    this.#fade = setTimeout(() => this.invalidate(), boxesLastFor + 20);
    this.invalidate();
  }

  /** Draws again soon; many calls in a row draw once. */
  invalidate() {
    if (this.#queued) return;
    this.#queued = true;
    requestAnimationFrame(() => {
      this.#queued = false;
      this.#draw();
    });
  }

  #mapping() {
    const video = this.#video;
    if (!video.videoWidth || !video.videoHeight) return null;
    return fitMapping(video.videoWidth, video.videoHeight, this.#canvas.clientWidth, this.#canvas.clientHeight);
  }

  /** The things that can be dragged, where they are on the screen. */
  #handles(map) {
    const settings = this.#settings();
    const zone = clampBox(settings.scanZone);
    const handles = [
      { name: 'nw', x: map.viewX(zone.x), y: map.viewY(zone.y) },
      { name: 'ne', x: map.viewX(zone.x + zone.width), y: map.viewY(zone.y) },
      { name: 'sw', x: map.viewX(zone.x), y: map.viewY(zone.y + zone.height) },
      { name: 'se', x: map.viewX(zone.x + zone.width), y: map.viewY(zone.y + zone.height) },
    ];
    if (settings.timingMode === 'line') {
      // Listed last, so that the line wins where it ends in a corner.
      handles.push({ name: 'a', x: map.viewX(settings.line.a.x), y: map.viewY(settings.line.a.y) });
      handles.push({ name: 'b', x: map.viewX(settings.line.b.x), y: map.viewY(settings.line.b.y) });
    }
    return handles;
  }

  #point(event) {
    const bounds = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  #down(event) {
    if (!this.#adjusting || this.#drag) return;
    const map = this.#mapping();
    if (!map) return;
    const at = this.#point(event);
    let nearest = null;
    for (const handle of this.#handles(map)) {
      const distance = Math.hypot(handle.x - at.x, handle.y - at.y);
      if (distance <= reach && (nearest === null || distance <= nearest.distance)) nearest = { handle, distance };
    }
    if (!nearest) return;
    event.preventDefault();
    try {
      this.#canvas.setPointerCapture(event.pointerId);
    } catch {
      // The touch has ended already.
    }
    const settings = this.#settings();
    this.#drag = {
      pointer: event.pointerId,
      name: nearest.handle.name,
      // To go back to if the line is dragged into something unusable.
      line: { a: { ...settings.line.a }, b: { ...settings.line.b }, reversed: settings.line.reversed },
    };
  }

  #moved(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    const map = this.#mapping();
    if (!map) return;
    event.preventDefault();
    const at = this.#point(event);
    const point = clampPoint(map.toPicture(at.x, at.y));
    const settings = this.#settings();
    if (drag.name === 'a' || drag.name === 'b') {
      settings.line = { ...settings.line, [drag.name]: point };
    } else {
      const zone = clampBox(settings.scanZone);
      let left = zone.x;
      let top = zone.y;
      let right = zone.x + zone.width;
      let bottom = zone.y + zone.height;
      if (drag.name.includes('w')) left = Math.min(point.x, right - smallestZone);
      if (drag.name.includes('e')) right = Math.max(point.x, left + smallestZone);
      if (drag.name.includes('n')) top = Math.min(point.y, bottom - smallestZone);
      if (drag.name.includes('s')) bottom = Math.max(point.y, top + smallestZone);
      settings.scanZone = clampBox({ x: left, y: top, width: right - left, height: bottom - top });
    }
    this.#onAdjust(false);
    this.invalidate();
  }

  #up(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    this.#drag = null;
    const settings = this.#settings();
    // Two ends on top of each other give no direction.
    if (!lineIsUsable(settings.line)) settings.line = drag.line;
    this.#onAdjust(true);
    this.invalidate();
  }

  #draw() {
    const canvas = this.#canvas;
    const context = this.#context;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const map = this.#mapping();
    if (!map) return;

    const settings = this.#settings();
    const picture = { left: map.viewX(0), top: map.viewY(0), right: map.viewX(1), bottom: map.viewY(1) };
    const zone = clampBox(settings.scanZone);
    const box = { left: map.viewX(zone.x), top: map.viewY(zone.y), right: map.viewX(zone.x + zone.width), bottom: map.viewY(zone.y + zone.height) };
    const whole = zone.width > 0.995 && zone.height > 0.995;

    // What is outside the search area is dimmed.
    if (!whole) {
      context.fillStyle = 'rgba(0, 0, 0, 0.5)';
      context.fillRect(picture.left, picture.top, picture.right - picture.left, box.top - picture.top);
      context.fillRect(picture.left, box.bottom, picture.right - picture.left, picture.bottom - box.bottom);
      context.fillRect(picture.left, box.top, box.left - picture.left, box.bottom - box.top);
      context.fillRect(box.right, box.top, picture.right - box.right, box.bottom - box.top);
    }
    if (!whole || this.#adjusting) {
      context.save();
      context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      context.lineWidth = 1.5;
      context.setLineDash([8, 6]);
      context.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      context.restore();
    }

    if (settings.timingMode === 'line') this.#drawLine(context, map, picture, settings.line);

    if (performance.now() - this.#boxesAt < boxesLastFor) {
      context.font = '600 15px system-ui, -apple-system, sans-serif';
      context.textBaseline = 'middle';
      // The boxes are from a picture taken a moment ago, and the runners
      // have moved on since. Each box is drawn where its bib will be in the
      // picture now on show, going by how the bib was moving.
      const shown = performance.now() - (settings.cameraDelay ?? 0);
      const ahead = Math.min(1.6, Math.max(0, (shown - this.#boxesTaken) / 1000));
      let moving = false;
      for (const found of this.#boxes) {
        const colour = colours[found.state] ?? colours.pending;
        if (found.velocity) moving = true;
        const x = found.box.x + (found.velocity?.x ?? 0) * ahead;
        const y = found.box.y + (found.velocity?.y ?? 0) * ahead;
        const left = map.viewX(x);
        const top = map.viewY(y);
        const boxWidth = map.viewX(x + found.box.width) - left;
        const boxHeight = map.viewY(y + found.box.height) - top;
        context.strokeStyle = colour;
        context.lineWidth = found.state === 'pending' ? 2 : 3;
        context.strokeRect(left, top, boxWidth, boxHeight);
        const label = found.bib;
        const labelWidth = context.measureText(label).width + 12;
        const labelTop = top - 22 >= picture.top ? top - 22 : top + boxHeight + 2;
        context.fillStyle = colour;
        context.fillRect(left - 1, labelTop, labelWidth, 20);
        context.fillStyle = '#111317';
        context.fillText(label, left + 5, labelTop + 10.5);
      }
      if (moving) this.invalidate();
    }

    if (this.#adjusting) {
      for (const handle of this.#handles(map)) {
        context.beginPath();
        if (handle.name === 'a' || handle.name === 'b') context.arc(handle.x, handle.y, 14, 0, Math.PI * 2);
        else context.rect(handle.x - 11, handle.y - 11, 22, 22);
        context.fillStyle = '#ffffff';
        context.fill();
        context.lineWidth = 3;
        context.strokeStyle = handle.name === 'a' || handle.name === 'b' ? lineColour : '#111317';
        context.stroke();
      }
    }
  }

  #drawLine(context, map, picture, line) {
    const ax = map.viewX(line.a.x);
    const ay = map.viewY(line.a.y);
    const bx = map.viewX(line.b.x);
    const by = map.viewY(line.b.y);
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1) return;
    const ux = (bx - ax) / length;
    const uy = (by - ay) / length;

    context.save();
    context.beginPath();
    context.rect(picture.left, picture.top, picture.right - picture.left, picture.bottom - picture.top);
    context.clip();
    // The line runs across the whole picture; the part between its two ends is drawn heavier.
    const far = 10_000;
    context.strokeStyle = lineColour;
    context.globalAlpha = 0.55;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(ax - ux * far, ay - uy * far);
    context.lineTo(bx + ux * far, by + uy * far);
    context.stroke();
    context.globalAlpha = 1;
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.stroke();

    // An arrow across the line, pointing the way runners go.
    const middleX = (ax + bx) / 2;
    const middleY = (ay + by) / 2;
    let px = -uy;
    let py = ux;
    const probe = map.toPicture(middleX + px * 20, middleY + py * 20);
    if (sideOfLine(line, probe) < 0) {
      px = -px;
      py = -py;
    }
    const tipX = middleX + px * 34;
    const tipY = middleY + py * 34;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(middleX, middleY);
    context.lineTo(tipX, tipY);
    context.stroke();
    context.fillStyle = lineColour;
    context.beginPath();
    context.moveTo(tipX + px * 9, tipY + py * 9);
    context.lineTo(tipX + ux * 8, tipY + uy * 8);
    context.lineTo(tipX - ux * 8, tipY - uy * 8);
    context.closePath();
    context.fill();
    context.restore();
  }
}

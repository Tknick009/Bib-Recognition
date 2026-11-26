// Finds and reads text in a picture, with onnxruntime-web and the PP-OCR
// models: one model marks where text is, a second reads each marked piece.
//
// Works on plain RGBA pixels, so it runs the same in a page, in a worker and
// in tests. Everything about bibs (which texts are bib numbers, following
// them from picture to picture) is somebody else's business.

const detMean = [0.485, 0.456, 0.406];
const detStd = [0.229, 0.224, 0.225];

/** Rounds to a multiple of 32, which the detection model needs. */
function toMultipleOf32(value) {
  return Math.max(32, Math.round(value / 32) * 32);
}

/**
 * Shrinks (or, slightly, enlarges) an RGBA picture into a planar float
 * tensor in blue-green-red order, the way the models were trained.
 *
 * Each output pixel is the average of the input pixels it covers, so that
 * shrinking a large frame does not turn thin strokes into noise.
 */
export function toTensor(rgba, width, height, region, outWidth, outHeight, normalize) {
  const out = new Float32Array(3 * outWidth * outHeight);
  const plane = outWidth * outHeight;
  const scaleX = region.width / outWidth;
  const scaleY = region.height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = region.y + y * scaleY;
    const y1 = region.y + (y + 1) * scaleY;
    const rowStart = Math.max(0, Math.floor(y0));
    const rowEnd = Math.min(height, Math.max(rowStart + 1, Math.ceil(y1)));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = region.x + x * scaleX;
      const x1 = region.x + (x + 1) * scaleX;
      const colStart = Math.max(0, Math.floor(x0));
      const colEnd = Math.min(width, Math.max(colStart + 1, Math.ceil(x1)));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = rowStart; sy < rowEnd; sy += 1) {
        let index = (sy * width + colStart) * 4;
        for (let sx = colStart; sx < colEnd; sx += 1) {
          r += rgba[index];
          g += rgba[index + 1];
          b += rgba[index + 2];
          count += 1;
          index += 4;
        }
      }
      const at = y * outWidth + x;
      if (count === 0) count = 1;
      out[at] = normalize(b / count, 0);
      out[plane + at] = normalize(g / count, 1);
      out[2 * plane + at] = normalize(r / count, 2);
    }
  }
  return out;
}

const forDetection = (value, channel) => (value / 255 - detMean[channel]) / detStd[channel];
const forRecognition = (value) => value / 127.5 - 1;

/**
 * Turns the detection model's map (how text-like each pixel is) into boxes.
 * Returns boxes in the map's own pixel coordinates, with a score each.
 */
export function boxesFromMap(map, mapWidth, mapHeight, { threshold = 0.3, boxThreshold = 0.5, unclip = 1.6, minSide = 3 } = {}) {
  const seen = new Uint8Array(mapWidth * mapHeight);
  const stack = new Int32Array(mapWidth * mapHeight);
  const boxes = [];
  for (let start = 0; start < map.length; start += 1) {
    if (seen[start] || map[start] <= threshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = mapWidth;
    let maxX = -1;
    let minY = mapHeight;
    let maxY = -1;
    let sum = 0;
    let count = 0;
    while (top > 0) {
      const at = stack[--top];
      const x = at % mapWidth;
      const y = (at - x) / mapWidth;
      sum += map[at];
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= mapHeight) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= mapWidth) continue;
          const next = ny * mapWidth + nx;
          if (!seen[next] && map[next] > threshold) {
            seen[next] = 1;
            stack[top++] = next;
          }
        }
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (Math.min(width, height) < minSide) continue;
    const score = sum / count;
    if (score < boxThreshold) continue;
    // The model marks the core of each text; the text itself reaches further.
    const grow = (width * height * unclip) / (2 * (width + height));
    boxes.push({
      x: Math.max(0, minX - grow),
      y: Math.max(0, minY - grow),
      right: Math.min(mapWidth, maxX + 1 + grow),
      bottom: Math.min(mapHeight, maxY + 1 + grow),
      score,
    });
  }
  return boxes;
}

/** Reads the recognition model's answer for one text: its characters and how sure it is. */
export function decodeText(probabilities, offset, steps, classes, dictionary) {
  let text = '';
  let confidence = 0;
  let kept = 0;
  let previous = 0;
  for (let step = 0; step < steps; step += 1) {
    const base = offset + step * classes;
    let best = 0;
    let bestValue = probabilities[base];
    for (let index = 1; index < classes; index += 1) {
      const value = probabilities[base + index];
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    }
    // Class 0 means "nothing here"; a repeated class is the same character still.
    if (best !== 0 && best !== previous) {
      text += dictionary[best - 1] ?? '';
      confidence += bestValue;
      kept += 1;
    }
    previous = best;
  }
  return { text, confidence: kept === 0 ? 0 : confidence / kept };
}

/**
 * @param {object} options
 * @param {object} options.ort the onnxruntime-web module
 * @param {ArrayBuffer|Uint8Array} options.detection the detection model
 * @param {ArrayBuffer|Uint8Array} options.recognition the recognition model
 * @param {string[]} options.dictionary the recognition model's characters, in order
 */
export async function createEngine({ ort, detection, recognition, dictionary, sessionOptions = {} }) {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions };
  const detector = await ort.InferenceSession.create(detection, options);
  const recognizer = await ort.InferenceSession.create(recognition, options);
  const detInput = detector.inputNames[0];
  const detOutput = detector.outputNames[0];
  const recInput = recognizer.inputNames[0];
  const recOutput = recognizer.outputNames[0];
  // The dictionary lists the characters; the model adds a space at the end.
  const characters = [...dictionary, ' '];

  /**
   * Finds and reads the text in a picture.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba the picture's pixels
   * @param {number} width
   * @param {number} height
   * @param {object} settings
   * @param {{x:number,y:number,width:number,height:number}} [settings.region] the part to look at, in pixels
   * @param {number} [settings.maxSide] the longest side the picture is shrunk to for finding text
   * @param {number} [settings.minHeight] texts lower than this many pixels are not read
   * @param {number} [settings.maxTexts] at most this many texts are read
   * @returns texts with their boxes in the picture's pixel coordinates
   */
  async function scan(rgba, width, height, { region = null, maxSide = 960, minHeight = 0, maxTexts = 24, minAspect = 0, maxAspect = Infinity } = {}) {
    const area = region ?? { x: 0, y: 0, width, height };
    const shrink = Math.min(1, maxSide / Math.max(area.width, area.height));
    const mapWidth = toMultipleOf32(area.width * shrink);
    const mapHeight = toMultipleOf32(area.height * shrink);
    const started = performance.now();

    const input = toTensor(rgba, width, height, area, mapWidth, mapHeight, forDetection);
    const found = await detector.run({ [detInput]: new ort.Tensor('float32', input, [1, 3, mapHeight, mapWidth]) });
    const map = found[detOutput].data;
    const afterDetection = performance.now();

    const toPictureX = area.width / mapWidth;
    const toPictureY = area.height / mapHeight;
    let boxes = boxesFromMap(map, mapWidth, mapHeight).map((box) => ({
      x: area.x + box.x * toPictureX,
      y: area.y + box.y * toPictureY,
      width: (box.right - box.x) * toPictureX,
      height: (box.bottom - box.y) * toPictureY,
      score: box.score,
    })).filter((box) => box.height >= minHeight && box.width >= 2 && box.height >= 2);
    const everything = boxes.length;
    // A text much wider than it is high is a line of words, not a number.
    boxes = boxes.filter((box) => box.width / box.height >= minAspect && box.width / box.height <= maxAspect);
    // A little more to the left and right, so that the first or last digit
    // is not cut when the box came out a touch too narrow.
    boxes = boxes.map((box) => {
      const pad = box.height * 0.12;
      const left = Math.max(area.x, box.x - pad);
      const right = Math.min(area.x + area.width, box.x + box.width + pad);
      return { ...box, x: left, width: right - left };
    });
    // If there are too many, the biggest are the likeliest to be bibs.
    if (boxes.length > maxTexts) {
      boxes = boxes.sort((a, b) => b.height - a.height).slice(0, maxTexts);
    }

    const texts = [];
    // Each text is read at its own width: a number is short, and reading
    // costs in proportion to the width.
    const lineHeight = 48;
    for (const box of boxes) {
      const lineWidth = Math.min(320, Math.max(16, Math.ceil((lineHeight * box.width) / box.height / 8) * 8));
      const piece = toTensor(rgba, width, height, box, lineWidth, lineHeight, forRecognition);
      const read = await recognizer.run({ [recInput]: new ort.Tensor('float32', piece, [1, 3, lineHeight, lineWidth]) });
      const output = read[recOutput];
      const [, steps, classes] = output.dims;
      const { text, confidence } = decodeText(output.data, 0, steps, classes, characters);
      if (text.trim() !== '') {
        texts.push({ text: text.trim(), confidence, box: { x: box.x, y: box.y, width: box.width, height: box.height } });
      }
    }
    const finished = performance.now();
    return { texts, found: everything, read: boxes.length, timing: { detection: afterDetection - started, recognition: finished - afterDetection, total: finished - started } };
  }

  return { scan };
}

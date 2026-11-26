// What happens to the texts read in each picture while the camera is on:
// which of them are bib numbers, which bib each belongs to from picture to
// picture, when its time is taken, and what that does to the list of
// results. Nothing here touches the page, so all of it also runs in tests.

import { bibDetections } from './lib/bibfilter.js';
import { clampBox } from './lib/geometry.js';
import { CrossingLedger } from './lib/ledger.js';
import { BibTracker, defaultTrackerConfig } from './lib/tracker.js';

// The longest side the whole picture is shrunk to when text is looked for.
// Larger finds smaller bibs and takes longer, in proportion to the area.
export const detailLevels = { fast: 736, standard: 960, far: 1280 };

/**
 * Which part of the camera's picture to hand to the reader, and what to ask
 * of it.
 *
 * @param {object} settings the page's settings
 * @param {number} width the picture's width in pixels
 * @param {number} height
 * @returns {{zone: {x: number, y: number, width: number, height: number}, options: object}} the zone in whole pixels
 */
export function scanPlan(settings, width, height) {
  const part = clampBox(settings.scanZone);
  const x = Math.min(width - 1, Math.max(0, Math.floor(part.x * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(part.y * height)));
  const zone = {
    x, y,
    width: Math.max(1, Math.min(width - x, Math.round(part.width * width))),
    height: Math.max(1, Math.min(height - y, Math.round(part.height * height))),
  };
  // The zone is shrunk by as much as the whole picture would be, so a
  // smaller zone is quicker to search and bibs in it are found just as well.
  const shrink = Math.min(1, (detailLevels[settings.detail] ?? detailLevels.standard) / Math.max(width, height));
  const rules = settings.rules;
  return {
    zone,
    options: {
      maxSide: Math.max(64, Math.round(Math.max(zone.width, zone.height) * shrink)),
      // Text is boxed a little generously, so a box this high holds text of about the smallest height wanted.
      minHeight: rules.minTextHeight * height * 0.7,
      maxTexts: 24,
      // A line of words is much wider than it is high; a number is not.
      minAspect: 0.3,
      maxAspect: 0.85 * rules.maxDigits + 0.8,
    },
  };
}

/** Texts found in a zone, with their boxes as fractions of the whole picture. */
export function toPictureFractions(texts, zone, width, height) {
  return texts.map((found) => ({
    text: found.text,
    confidence: found.confidence,
    box: {
      x: (zone.x + found.box.x) / width,
      y: (zone.y + found.box.y) / height,
      width: found.box.width / width,
      height: found.box.height / height,
    },
  }));
}

/**
 * The part of the picture to keep as a photo of a bib: the bib with some of
 * its runner around it. Fractions of the whole picture.
 */
export function photoRegion(box) {
  const width = Math.min(1, Math.max(0.2, box.width * 3.5));
  const height = Math.min(1, Math.max(0.3, box.height * 7));
  const centerX = box.x + box.width / 2;
  // More above the bib than below: that is where the face is.
  const top = box.y + box.height / 2 - height * 0.6;
  return {
    x: Math.min(1 - width, Math.max(0, centerX - width / 2)),
    y: Math.min(1 - height, Math.max(0, top)),
    width,
    height,
  };
}

function sameLine(a, b) {
  return a.reversed === b.reversed && a.a.x === b.a.x && a.a.y === b.a.y && a.b.x === b.b.x && a.b.y === b.b.y;
}

export class Session {
  #clock;
  #deviceOffset;
  #tracker = new BibTracker(defaultTrackerConfig());
  #ledger = new CrossingLedger();
  #rules = null;
  #roster = null;
  #repeatRule = null;
  #race = null;
  #recording = false;

  /**
   * @param {object} options
   * @param {import('./lib/timesync.js').RaceClock} options.clock
   * @param {() => number} options.deviceOffset what to add to the local clock to get the iPad's own idea of the time
   */
  constructor({ clock, deviceOffset }) {
    this.#clock = clock;
    this.#deviceOffset = deviceOffset;
  }

  get recording() {
    return this.#recording;
  }

  /** Takes the settings and the race into use. Call again whenever either changes. */
  configure(settings, race) {
    const config = {
      ...defaultTrackerConfig(),
      mode: settings.timingMode,
      line: { a: { ...settings.line.a }, b: { ...settings.line.b }, reversed: settings.line.reversed },
      minSightings: settings.minSightings,
      // The page looks a few times a second, not thirty: a misread may
      // turn up a good second after the reading it belongs with.
      mergeWindow: 1.2,
    };
    const before = this.#tracker.config;
    if (before.mode !== config.mode || !sameLine(before.line, config.line)) {
      // Bibs being followed were on one side or the other of the old line.
      this.#tracker.reset();
    }
    this.#tracker.config = config;
    this.#rules = settings.rules;
    this.#repeatRule = settings.repeatRule;
    if (race !== this.#race) {
      this.#tracker.reset();
      this.#ledger.reset();
      this.#race = race;
    }
    this.#roster = race && race.restrictToRoster && race.roster.length > 0 ? new Set(race.roster.map((entry) => entry.bib)) : null;
  }

  /** From now on, bibs are given times. Bibs already in the picture start afresh. */
  start() {
    this.#tracker.reset();
    this.#ledger.reset();
    this.#recording = true;
  }

  /**
   * Stops giving times. Bibs still being followed get the best time there is for them.
   *
   * @returns {object[]} what that did to the results (see `take`)
   */
  stop() {
    if (!this.#recording) return [];
    const changes = this.#tracker.finish().map((event) => this.#apply(event)).filter((change) => change.change !== 'none');
    this.#ledger.reset();
    this.#recording = false;
    return changes;
  }

  /**
   * Takes in the texts read in one picture.
   *
   * @param {number} frameTime when the picture was taken, on the local clock, in milliseconds
   * @param {{text: string, confidence: number, box: object}[]} texts boxes as fractions of the whole picture
   * @returns {{changes: object[], overlays: object[]}} `changes` says what happened to the results:
   *   { change: 'added' | 'updated' | 'removed', id, bib, box, bibChanged }; `overlays` is for drawing.
   */
  take(frameTime, texts) {
    const detections = bibDetections(texts, this.#rules, this.#roster);
    const { events, overlays } = this.#tracker.process(frameTime / 1000, detections);
    // While nothing is being recorded the bibs are still followed, so that
    // the picture shows what would happen; their reports are let go.
    const changes = this.#recording && this.#race
      ? events.map((event) => this.#apply(event)).filter((change) => change.change !== 'none')
      : [];
    return { changes, overlays };
  }

  #apply(event) {
    const offset = this.#deviceOffset();
    const stamp = this.#clock.at(event.time * 1000, offset);
    const crossings = this.#race.crossings;
    const report = {
      trackID: event.trackID,
      bib: event.bib,
      time: stamp.time,
      timing: event.timing,
      clock: { source: stamp.source, error: stamp.error },
      firstSeen: this.#clock.at(event.firstSeen * 1000, offset).time,
      lastSeen: this.#clock.at(event.lastSeen * 1000, offset).time,
      sightings: event.sightings,
      confidence: event.confidence,
      ended: event.ended,
    };
    const tracked = this.#ledger.recordedFor(event.trackID);
    const before = tracked === null ? null : crossings.find((crossing) => crossing.id === tracked)?.bib ?? null;
    const result = this.#ledger.apply(report, crossings, this.#repeatRule);
    const after = result.change === 'updated' ? crossings.find((crossing) => crossing.id === result.id)?.bib ?? null : null;
    return { change: result.change, id: result.id ?? null, bib: event.bib, box: event.box, bibChanged: result.change === 'updated' && before !== after };
  }
}

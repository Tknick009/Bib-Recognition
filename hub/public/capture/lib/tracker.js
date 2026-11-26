// Follows bib numbers from picture to picture and decides when each one's
// time is to be taken.
//
// Readings of the same number, and slightly different readings in the same
// place (a digit hidden by an arm, a misread), are gathered into one track.
// A track reports the number most of its readings agree on.
//
// Times here are plain seconds on whatever clock the caller uses; all that
// matters is that they run evenly.

import { centerOf, sideOfLine, standardLine } from './geometry.js';

export function defaultTrackerConfig() {
  return {
    // Which moment is recorded as a bib's time:
    //   'line'       when the bib crosses the finish line drawn on the picture
    //   'firstSeen'  the first picture in which it was read
    //   'lastSeen'   the last picture in which it was read
    mode: 'line',
    line: standardLine,
    // Pictures in which a number must be read before it is believed.
    minSightings: 2,
    // A bib that has not been read for this long has left the picture. Long
    // enough to bridge a runner being hidden behind another for a moment, so
    // that the crossing can still be worked out across the gap.
    trackTimeout: 2.0,
    // How long after a sighting a slightly different number in the same
    // place is still taken for a misread of the same bib.
    mergeWindow: 0.5,
  };
}

/** Whether one number could be a misreading of the other: a single wrong digit, or digits missing. */
export function isSimilar(a, b) {
  if (a === b) return true;
  if (a.length === b.length) {
    if (a.length < 2) return false;
    let differences = 0;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) differences += 1;
    }
    return differences === 1;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let matched = 0;
  for (const character of longer) {
    if (matched < shorter.length && character === shorter[matched]) matched += 1;
  }
  return matched === shorter.length;
}

/**
 * Whether two boxes could be the same bib.
 *
 * @param {number} reach how much further apart than usual they may be (1 = the usual)
 */
export function isNear(a, b, reach = 1) {
  if (!(a.height > 0) || !(b.height > 0)) return false;
  const ratio = a.height / b.height;
  if (!(ratio > 0.5 && ratio < 2)) return false;
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const first = centerOf(a);
  const second = centerOf(b);
  return Math.abs(first.x - second.x) <= 0.75 * width * reach && Math.abs(first.y - second.y) <= height * reach;
}

function distance(a, b) {
  const first = centerOf(a);
  const second = centerOf(b);
  return Math.hypot(first.x - second.x, first.y - second.y);
}

/** Whether reading `a` is to be preferred to reading `b` as a track's number. */
function prefers(a, ra, b, rb) {
  if (ra.weight !== rb.weight) return ra.weight > rb.weight;
  if (ra.count !== rb.count) return ra.count > rb.count;
  // A longer number is more likely than a shorter one to be complete.
  if (a.length !== b.length) return a.length > b.length;
  return a < b;
}

class Track {
  constructor(id, detection, time, line) {
    this.id = id;
    this.readings = new Map([[detection.bib, { count: 1, weight: detection.confidence, best: detection.confidence }]]);
    this.firstSeen = time;
    this.lastSeen = time;
    this.frames = 1;
    this.box = detection.box;
    // How fast the bib moves across the picture, per second; unknown until it has been seen twice.
    this.velocity = null;
    // Which side of the finish line the bib was on when first and last read.
    const side = sideOfLine(line, centerOf(detection.box));
    this.firstSide = side;
    this.lastSide = side;
    this.crossingTime = null;
    // Set once the track's time has been reported.
    this.timingPoint = null;
    this.timingKind = 'estimated';
    this.reportedBib = null;
  }

  add(detection, time, line) {
    const reading = this.readings.get(detection.bib) ?? { count: 0, weight: 0, best: 0 };
    reading.count += 1;
    reading.weight += detection.confidence;
    reading.best = Math.max(reading.best, detection.confidence);
    this.readings.set(detection.bib, reading);

    const side = sideOfLine(line, centerOf(detection.box));
    if (this.crossingTime === null && this.lastSide < 0 && side >= 0) {
      // The bib moved from the approach side to the finished side between
      // the previous sighting and this one.
      const fraction = -this.lastSide / (side - this.lastSide);
      this.crossingTime = this.lastSeen + (time - this.lastSeen) * fraction;
    }
    const elapsed = time - this.lastSeen;
    if (elapsed > 0) {
      const from = centerOf(this.box);
      const to = centerOf(detection.box);
      this.velocity = { x: (to.x - from.x) / elapsed, y: (to.y - from.y) / elapsed };
    }
    this.lastSide = side;
    this.lastSeen = time;
    this.box = detection.box;
    this.frames += 1;
  }

  /** Where the bib would be at `time` if it kept moving as it last did. */
  expectedBox(time) {
    if (!this.velocity) return this.box;
    const elapsed = time - this.lastSeen;
    return { ...this.box, x: this.box.x + this.velocity.x * elapsed, y: this.box.y + this.velocity.y * elapsed };
  }

  /** The number most readings agree on: { bib, reading }. */
  get best() {
    let result = null;
    for (const [bib, reading] of this.readings) {
      if (result === null || prefers(bib, reading, result.bib, result.reading)) result = { bib, reading };
    }
    return result;
  }

  overlay(minSightings) {
    const best = this.best;
    let state = 'pending'; // read too few times to be believed yet
    if (this.timingPoint !== null) state = 'timed'; // its time has been taken
    else if (best && best.reading.count >= minSightings) state = 'tracking'; // believed, waiting for its moment
    // `velocity` (per second, or null) lets whoever draws the box keep it on
    // the bib between one picture that is looked at and the next.
    return { id: this.id, bib: best ? best.bib : '', box: this.box, state, velocity: this.velocity };
  }
}

/** Gives each detection the nearest track on offer, nearest pairs first. */
function assign(pairs, assignment, taken) {
  pairs.sort((a, b) => a.distance - b.distance);
  for (const pair of pairs) {
    if (assignment[pair.detection] !== null || taken.has(pair.track)) continue;
    assignment[pair.detection] = pair.track;
    taken.add(pair.track);
  }
}

export class BibTracker {
  #tracks = [];
  #nextID = 1;

  constructor(config = defaultTrackerConfig()) {
    this.config = config;
  }

  get activeTrackCount() {
    return this.#tracks.length;
  }

  /**
   * Takes in the bibs read in one picture, taken at `time`. Must be called
   * for every picture that was looked at, also those without bibs, so that
   * tracks can run out.
   *
   * Returns `events` (reports about tracks: the first one for a track
   * carries its time, later ones correct the number or mark its end) and
   * `overlays` (the bibs in this picture, for drawing: { id, bib, box,
   * state, velocity }).
   */
  process(time, detections) {
    const config = this.config;
    const events = this.#expire(time);
    const tracks = this.#tracks;

    const assignment = new Array(detections.length).fill(null);
    const taken = new Set();

    // A detection whose number a track has already read belongs to that track.
    let pairs = [];
    detections.forEach((detection, d) => {
      tracks.forEach((track, t) => {
        if (track.readings.has(detection.bib)) pairs.push({ detection: d, track: t, distance: distance(detection.box, track.box) });
      });
    });
    assign(pairs, assignment, taken);

    // A similar number where the bib would be by now, moments later, is a
    // misread of the same bib.
    pairs = [];
    detections.forEach((detection, d) => {
      if (assignment[d] !== null) return;
      tracks.forEach((track, t) => {
        if (taken.has(t)) return;
        const elapsed = time - track.lastSeen;
        if (elapsed > config.mergeWindow) return;
        const best = track.best;
        if (!best || !isSimilar(detection.bib, best.bib)) return;
        const expected = track.expectedBox(time);
        // The longer ago it was seen, the less exactly it is where expected.
        const reach = 1 + Math.min(0.5, Math.max(0, elapsed - 0.1));
        if (!isNear(detection.box, expected, reach)) return;
        pairs.push({ detection: d, track: t, distance: distance(detection.box, expected) });
      });
    });
    assign(pairs, assignment, taken);

    const touched = [];
    detections.forEach((detection, d) => {
      if (assignment[d] !== null) {
        tracks[assignment[d]].add(detection, time, config.line);
        touched.push(tracks[assignment[d]]);
      } else {
        const track = new Track(this.#nextID, detection, time, config.line);
        this.#nextID += 1;
        tracks.push(track);
        touched.push(track);
      }
    });

    const overlays = [];
    for (const track of touched) {
      const event = this.#report(track, false);
      if (event) events.push(event);
      overlays.push(track.overlay(config.minSightings));
    }
    return { events, overlays };
  }

  /** Ends every track, as when recording stops. Bibs that were being followed get their best available time. */
  finish() {
    const events = [];
    for (const track of this.#tracks) {
      const event = this.#report(track, true);
      if (event) events.push(event);
    }
    this.#tracks = [];
    return events;
  }

  /** Forgets every track without reporting anything. */
  reset() {
    this.#tracks = [];
  }

  #expire(now) {
    const events = [];
    const remaining = [];
    for (const track of this.#tracks) {
      if (now - track.lastSeen > this.config.trackTimeout) {
        const event = this.#report(track, true);
        if (event) events.push(event);
      } else {
        remaining.push(track);
      }
    }
    this.#tracks = remaining;
    return events;
  }

  /** The report to publish for a track that has just changed or ended, if any. */
  #report(track, ended) {
    const config = this.config;
    const best = track.best;
    if (!best || best.reading.count < config.minSightings) return null;

    let isNew;
    if (track.timingPoint === null) {
      const point = this.#timingPoint(track, ended);
      if (point === null) return null;
      track.timingPoint = point;
      track.timingKind = config.mode === 'line' ? (track.crossingTime !== null ? 'line' : 'estimated') : config.mode;
      isNew = true;
    } else {
      if (!ended && track.reportedBib === best.bib) return null;
      isNew = false;
    }
    track.reportedBib = best.bib;

    return {
      trackID: track.id,
      bib: best.bib,
      time: track.timingPoint,
      timing: track.timingKind,
      firstSeen: track.firstSeen,
      lastSeen: track.lastSeen,
      sightings: track.frames,
      confidence: best.reading.best,
      box: track.box,
      isNew,
      ended,
    };
  }

  /** The moment to record for a track, once it is known; null until then. */
  #timingPoint(track, ended) {
    switch (this.config.mode) {
      case 'firstSeen':
        return track.firstSeen;
      case 'lastSeen':
        return ended ? track.lastSeen : null;
      default:
        if (track.crossingTime !== null) return track.crossingTime;
        // First read when already past the line: the first sighting is the
        // closest thing to the crossing there will ever be.
        if (track.firstSide >= 0) return track.firstSeen;
        // Still approaching: wait for the crossing. If the bib is lost
        // before it gets there, the last sighting has to do.
        return ended ? track.lastSeen : null;
    }
  }
}

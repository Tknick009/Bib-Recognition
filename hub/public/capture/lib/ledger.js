// Turns the tracker's reports into results ("crossings"), applying the rule
// about repeats and following a track when its number is corrected after it
// has been recorded.
//
// A crossing is a plain object:
//   { id, bib, time, timing, source, clock, clockError, confidence,
//     sightings, firstSeen, lastSeen, detectedBib, note }
// with times in seconds since 1970. `bib` is empty for a mark made by hand
// that has not been given its number yet; `detectedBib` keeps what the camera
// read once a person has corrected it.

export function defaultRepeatRule() {
  return {
    // Off for a finish line (each bib is recorded once); on for laps.
    allowRepeats: false,
    // With repeats on, the shortest time in seconds between two crossings of one bib.
    minInterval: 30,
  };
}

/** A new identifier for a crossing. */
export function newID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toUpperCase();
  // Pages not served over HTTPS have no randomUUID; the random numbers are still there.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A crossing entered by hand at the given moment. */
export function manualCrossing(bib, time, clock) {
  return {
    id: newID(), bib, time, timing: 'manual', source: 'manual',
    clock: clock.source, clockError: clock.error ?? null,
    confidence: null, sightings: null, firstSeen: null, lastSeen: null, detectedBib: null, note: '',
  };
}

/** Whether the rule about repeats forbids another crossing for this bib. */
export function isBlocked(bib, time, crossings, excluding, rule) {
  return crossings.some((other) => {
    if (other.bib !== bib || other.id === excluding) return false;
    if (!rule.allowRepeats) return true;
    return Math.abs(other.time - time) < rule.minInterval;
  });
}

function sameCrossing(a, b) {
  return a.bib === b.bib && a.lastSeen === b.lastSeen && a.sightings === b.sightings && a.confidence === b.confidence;
}

export class CrossingLedger {
  // What became of each track that is still being followed:
  // { recorded: id } or { suppressed: bib }.
  #states = new Map();

  reset() {
    this.#states.clear();
  }

  /** The identifier of the crossing recorded for a track that is still being followed; null if there is none. */
  recordedFor(trackID) {
    return this.#states.get(trackID)?.recorded ?? null;
  }

  /**
   * Applies one report to the list of crossings, changing it in place.
   *
   * A report is { trackID, bib, time, timing, clock: { source, error },
   * firstSeen, lastSeen, sightings, confidence, ended }.
   *
   * Returns { change: 'none' | 'added' | 'updated' | 'removed', id }.
   */
  apply(report, crossings, rule) {
    const change = this.#resolve(report, crossings, rule);
    if (report.ended) this.#states.delete(report.trackID);
    return change;
  }

  #resolve(report, crossings, rule) {
    const state = this.#states.get(report.trackID);
    if (!state) return this.#record(report, crossings, rule);

    if (state.suppressed !== undefined) {
      // Still the number that was recorded already: nothing to do.
      return state.suppressed === report.bib ? { change: 'none' } : this.#record(report, crossings, rule);
    }

    const index = crossings.findIndex((crossing) => crossing.id === state.recorded);
    // Deleted by hand while the bib was still in view: it stays deleted.
    if (index < 0) return { change: 'none' };
    const crossing = { ...crossings[index] };
    // A number corrected by hand is never overwritten by the camera.
    if (crossing.detectedBib == null && crossing.bib !== report.bib) {
      if (isBlocked(report.bib, crossing.time, crossings, crossing.id, rule)) {
        // The track turned out to be a bib that is recorded already; its
        // crossing was a misread.
        crossings.splice(index, 1);
        this.#states.set(report.trackID, { suppressed: report.bib });
        return { change: 'removed', id: crossing.id };
      }
      crossing.bib = report.bib;
    }
    crossing.lastSeen = report.lastSeen;
    crossing.sightings = report.sightings;
    crossing.confidence = report.confidence;
    if (sameCrossing(crossing, crossings[index])) return { change: 'none' };
    crossings[index] = crossing;
    return { change: 'updated', id: crossing.id };
  }

  #record(report, crossings, rule) {
    if (isBlocked(report.bib, report.time, crossings, null, rule)) {
      this.#states.set(report.trackID, { suppressed: report.bib });
      return { change: 'none' };
    }
    const crossing = {
      id: newID(), bib: report.bib, time: report.time, timing: report.timing, source: 'camera',
      clock: report.clock.source, clockError: report.clock.error ?? null,
      confidence: report.confidence, sightings: report.sightings,
      firstSeen: report.firstSeen, lastSeen: report.lastSeen, detectedBib: null, note: '',
    };
    crossings.push(crossing);
    this.#states.set(report.trackID, { recorded: crossing.id });
    return { change: 'added', id: crossing.id };
  }
}

/** Crossings in finishing order. */
export function inFinishingOrder(crossings) {
  return [...crossings].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Bib numbers that are on more than one crossing. */
export function duplicateBibs(crossings) {
  const seen = new Set();
  const duplicates = new Set();
  for (const crossing of crossings) {
    if (crossing.bib === '') continue;
    if (seen.has(crossing.bib)) duplicates.add(crossing.bib);
    seen.add(crossing.bib);
  }
  return duplicates;
}

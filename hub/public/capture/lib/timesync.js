// Keeps the page's clock in step with the hub's.
//
// A page in a browser cannot ask a time server itself (that takes a kind of
// network message pages are not allowed to send). It asks the hub instead,
// the same way a time server is asked: note when the question left, when the
// hub got it, when the hub answered and when the answer arrived. Half the
// time spent on the way is how far off the result can be. The hub in turn
// checks its own clock against time servers.
//
// All times here are milliseconds. "Local" times come from a clock that only
// ever runs forward evenly (not the clock in the corner of the screen, which
// can be set).

/**
 * What one question to the hub says about the clocks.
 *
 * @param {object} times `sent` and `received` on the local clock; `serverReceived` and `serverSent` on the hub's
 * @returns {{offset: number, delay: number}} hub time minus local time, and the time spent on the way
 */
export function measure({ sent, received, serverReceived, serverSent }) {
  return {
    offset: ((serverReceived - sent) + (serverSent - received)) / 2,
    delay: (received - sent) - (serverSent - serverReceived),
  };
}

/** The measurement to trust: the one that spent the least time on the way. */
export function bestOf(samples) {
  let best = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.offset) || !Number.isFinite(sample.delay) || sample.delay < 0) continue;
    if (best === null || sample.delay < best.delay) best = sample;
  }
  return best;
}

// How fast the local clock may drift from true time: 20 millionths, which is
// 72 ms an hour. Makes an old fix count for less than a fresh one.
const drift = 20e-6;
// A fix this old is replaced by any newer one, however rough.
const oldAfter = 15 * 60 * 1000;

export class RaceClock {
  #localNow;
  #fix = null;

  /** @param {() => number} localNow the local clock, in milliseconds */
  constructor(localNow) {
    this.#localNow = localNow;
  }

  /** The fix in use: { offset, error, at } or null. */
  get fix() {
    return this.#fix;
  }

  get isSynced() {
    return this.#fix !== null;
  }

  /** How far off the time could be at a local moment, in milliseconds; null without a fix. */
  errorAt(local) {
    if (!this.#fix) return null;
    return this.#fix.error + Math.abs(local - this.#fix.at) * drift;
  }

  /**
   * Takes a new measurement into use if it is better than what there is.
   *
   * @param {{offset: number, delay: number}} sample from `measure`
   * @param {number} hubError how far off the hub's own clock may be, in milliseconds
   * @returns {boolean} whether it was taken
   */
  adopt(sample, hubError = 0) {
    const local = this.#localNow();
    const fix = { offset: sample.offset, error: sample.delay / 2 + hubError, at: local };
    const current = this.#fix;
    if (current && local - current.at < oldAfter && fix.error > this.errorAt(local) + 2) return false;
    this.#fix = fix;
    return true;
  }

  /** Forgets the fix, as when the local clock may have stood still (the device slept). */
  forget() {
    this.#fix = null;
  }

  /**
   * The time of day at a local moment.
   *
   * @param {number} local a moment on the local clock; now if left out
   * @param {number} deviceOffset what to add to the local clock to get the device's own idea of the time
   * @returns {{time: number, source: 'ntp'|'device', error: number|null}} `time` in seconds since 1970, `error` in seconds
   */
  at(local = this.#localNow(), deviceOffset = 0) {
    if (!this.#fix) return { time: (local + deviceOffset) / 1000, source: 'device', error: null };
    return { time: (local + this.#fix.offset) / 1000, source: 'ntp', error: this.errorAt(local) / 1000 };
  }
}

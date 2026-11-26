// The capture page's dealings with the hub: checking the key, keeping the
// clock in step with the hub's, and sending results. Nothing here touches
// the page itself, so all of it also runs in tests.

import { hasChanges, planPush, stateAfter } from './lib/planner.js';
import { bestOf, measure } from './lib/timesync.js';

/** Something that went wrong between the page and the hub. */
export class Failure extends Error {
  /** @param {number} status the hub's answer, or 0 if there was none */
  constructor(message, status = 0) {
    super(message);
    this.name = 'Failure';
    this.status = status;
  }

  /** The hub could not be reached, or did not answer in time. */
  get unreachable() {
    return this.status === 0;
  }

  /** The hub answered, and the answer was no: asking again at once will not change it. */
  get turnedDown() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

async function messageOf(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not from the hub itself: something in between answered.
  }
  return `The results site answered ${response.status}.`;
}

export class HubLink {
  #fetch;
  #origin;
  /** The access key; empty until one has been entered. */
  key = '';

  /**
   * @param {object} options
   * @param {typeof fetch} options.fetch replaced in tests
   * @param {string} options.origin the hub's address; empty for the site the page came from
   */
  constructor({ fetch = (...args) => globalThis.fetch(...args), origin = '' } = {}) {
    this.#fetch = fetch;
    this.#origin = origin;
  }

  /**
   * Asks the hub for something. `read` is given the answer and what it
   * returns is passed on; all of it has to be done within `timeout`.
   */
  async #ask(path, { method = 'GET', body, headers = {}, keepalive = false, timeout = 15_000 } = {}, read) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await this.#fetch(this.#origin + path, {
          method, body, keepalive, cache: 'no-store', signal: controller.signal,
          headers: { Authorization: `Bearer ${this.key}`, ...headers },
        });
      } catch {
        throw new Failure(controller.signal.aborted ? 'The results site did not answer in time.' : 'The results site could not be reached.');
      }
      return await read(response);
    } catch (error) {
      if (error instanceof Failure) throw error;
      // Cut off while the answer was being read.
      throw new Failure('The answer from the results site was cut short.');
    } finally {
      clearTimeout(timer);
    }
  }

  /** The hub's answer as an object. Throws a `Failure` unless the hub said yes. */
  json(path, options = {}) {
    return this.#ask(path, options, async (response) => {
      if (!response.ok) throw new Failure(await messageOf(response), response.status);
      try {
        return await response.json();
      } catch {
        // A page from a Wi-Fi sign-in screen, say, in place of the hub's answer.
        throw new Failure('Something other than the results site answered.', 502);
      }
    });
  }

  /** Like `json`, and also notes the moment the answer began to arrive. */
  timed(path, now) {
    return this.#ask(path, { timeout: 8000 }, async (response) => {
      const received = now();
      if (!response.ok) throw new Failure(await messageOf(response), response.status);
      try {
        return { received, body: await response.json() };
      } catch {
        throw new Failure('Something other than the results site answered.', 502);
      }
    });
  }

  /** Checks the key. Answers { access: 'full' | 'view', capture: boolean, ... }. */
  ping() {
    return this.json('/api/ping');
  }

  /** The events the hub holds, most recently active first. */
  async events() {
    const body = await this.json('/api/events');
    return Array.isArray(body.events) ? body.events : [];
  }
}

// ---- The clock ----

const syncEvery = 5 * 60_000;

/** Keeps a `RaceClock` in step with the hub's clock. */
export class TimeKeeper {
  #link;
  #clock;
  #localNow;
  #wait;
  #refine;
  #onChange;
  #schedule;
  #cancel;
  #timer = null;
  #running = false;
  #syncing = null;
  #stamp;
  #count = 0;
  #failures = 0;
  #again = false;

  /** Whether the hub's own clock has been checked against time servers; null until the hub has been asked. */
  hubChecked = null;
  /** Why the last attempt failed; empty if it did not. */
  problem = '';
  /** When the hub was last asked successfully, on the local clock; null if never. */
  lastSync = null;
  /** What `stamp` gave when the measurement now in use was made; null if none has been taken into use. */
  fixStamp = null;

  /**
   * @param {object} options
   * @param {HubLink} options.link
   * @param {import('./lib/timesync.js').RaceClock} options.clock
   * @param {() => number} options.localNow the local clock that only runs forward, in milliseconds
   * @param {(path: string, sent: number, received: number) => ({sent: number, received: number}|null)} [options.refine]
   *   a better idea of when a question left and its answer came, if the browser has one
   * @param {() => number} [options.stamp] gives a number that changes by 100 or more when the local clock
   *   has jumped (the difference between the device's two clocks, in milliseconds). A measurement made
   *   before such a jump says nothing about the clock after it, and is not used.
   */
  constructor({
    link, clock, localNow, refine = null, stamp = () => 0, onChange = () => {},
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule = (run, ms) => setTimeout(run, ms), cancel = (timer) => clearTimeout(timer),
  }) {
    this.#link = link;
    this.#clock = clock;
    this.#localNow = localNow;
    this.#refine = refine;
    this.#stamp = stamp;
    this.#onChange = onChange;
    this.#wait = wait;
    this.#schedule = schedule;
    this.#cancel = cancel;
  }

  get syncing() {
    return this.#syncing !== null;
  }

  /** Asks now, and from then on every five minutes (sooner after a failure). */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#next(0);
  }

  stop() {
    this.#running = false;
    this.#cancel(this.#timer);
    this.#timer = null;
  }

  #next(delay) {
    this.#cancel(this.#timer);
    if (!this.#running) return;
    this.#timer = this.#schedule(async () => {
      const found = await this.sync();
      if (found) this.#failures = 0;
      else this.#failures += 1;
      this.#next(found ? syncEvery : Math.min(120_000, 10_000 * 2 ** Math.min(this.#failures - 1, 4)));
    }, delay);
  }

  async #once() {
    // A different address each time, so that the browser's own note of when
    // this question left and its answer came can be found again.
    this.#count += 1;
    const path = `/api/time?n=${this.#count}`;
    const sent = this.#localNow();
    const { received, body } = await this.#link.timed(path, this.#localNow);
    if (!Number.isFinite(body?.received) || !Number.isFinite(body?.sent)) throw new Failure('The results site sent no time.', 502);
    const times = this.#refine?.(path, sent, received) ?? { sent, received };
    return {
      ...measure({ ...times, serverReceived: body.received, serverSent: body.sent }),
      hubError: Number.isFinite(body.error) ? body.error : null,
      hubChecked: body.checked === true,
      stamp: this.#stamp(),
    };
  }

  /**
   * Asks the hub the time a few times over and takes the best answer into use.
   *
   * @param {object} options
   * @param {number} options.samples how many times to ask
   * @param {boolean} options.replace take the new answer whatever there is already,
   *   as when the local clock is known to have jumped
   * @returns {Promise<boolean>} whether the hub answered
   */
  sync({ samples = 6, replace = false } = {}) {
    if (this.#syncing) {
      // What is being measured at this moment may straddle the jump of the
      // clock that this call is about: measure once more when it is done.
      if (replace) this.#again = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      const taken = [];
      let failure = null;
      for (let asked = 0; asked < samples; asked += 1) {
        try {
          taken.push(await this.#once());
        } catch (error) {
          failure = error;
          // A wrong key stays wrong; a missing connection rarely comes back within a second.
          if (error.turnedDown || (error.unreachable && taken.length === 0)) break;
        }
        if (asked + 1 < samples) await this.#wait(120);
      }
      // Only what was measured with the clock as it is now.
      const stampNow = this.#stamp();
      const best = bestOf(taken.filter((sample) => Math.abs(sample.stamp - stampNow) < 100));
      if (!best) {
        this.problem = taken.length > 0
          ? 'The clock of this device jumped while it was being set.'
          : failure?.message ?? 'The results site sent no usable time.';
        return false;
      }
      if (replace) this.#clock.forget();
      if (this.#clock.adopt(best, best.hubError ?? 0)) this.fixStamp = best.stamp;
      this.hubChecked = best.hubChecked;
      this.problem = '';
      this.lastSync = this.#localNow();
      return true;
    })();
    this.#onChange();
    return this.#syncing.finally(() => {
      this.#syncing = null;
      this.#onChange();
      if (this.#again) {
        this.#again = false;
        this.sync({ samples, replace: true });
      }
    });
  }
}

// ---- Sending results ----

// An iPad with nothing new still says "I am here" this often, so that the
// results page can show that it is alive. Shorter than the minute after
// which hosting services close a connection nobody uses.
export const checkInEvery = 45_000;
// Roughly what an upload costs on top of its own text, both ways, on a
// connection that is already open (measured: see the README).
const overheadBytes = 400;

/** What a race is known by on this iPad. */
const keyOf = (race) => race.id ?? race.code;

/**
 * Sends the results of the races on this iPad to the hub: everything the
 * first time, after that only what has changed. Nothing is ever taken off
 * the hub except results that were deleted on this iPad (a race keeps their
 * identifiers in `deleted` until the hub has heard).
 */
export class Uploader {
  #link;
  #deviceID;
  #jobs;
  #onChange;
  #onSettled;
  #onHeard;
  #now;
  #schedule;
  #cancel;
  // What the hub is believed to hold of each race, by the race's own
  // identifier on this iPad. Not by its code on the hub: a race that was
  // cleared off the iPad and set up again has the same code, and none of
  // what was known about the first applies to the second.
  #known = new Map();
  #timer = null;
  #due = Infinity;
  #running = false;
  #sending = false;
  #lastContact = -Infinity;

  /** Attempts that have failed in a row. */
  failures = 0;
  /** True if the hub refused the last upload (a wrong key, say). */
  turnedDown = false;
  /** What went wrong the last time; empty if nothing did. */
  problem = '';
  /** When the hub last took an upload, in milliseconds since 1970; null if never. */
  lastSuccess = null;
  /** Roughly how much has been sent since the page was opened, in bytes. */
  bytes = 0;

  /**
   * @param {object} options
   * @param {HubLink} options.link
   * @param {string} options.deviceID tells this iPad from the others at an event
   * @param {() => {race: object, station: string, timeZone: string}[]} options.jobs the races to keep the hub
   *   up to date with: first the one in use, then any others with results the hub has not got yet
   * @param {(race: object) => void} [options.onSettled] called when the hub has everything of a race
   * @param {(race: object) => void} [options.onHeard] called when the hub has heard of deletions, and
   *   their identifiers have been taken out of the race's `deleted`
   */
  constructor({
    link, deviceID, jobs, onChange = () => {}, onSettled = () => {}, onHeard = () => {}, now = () => Date.now(),
    schedule = (run, ms) => setTimeout(run, ms), cancel = (timer) => clearTimeout(timer),
  }) {
    this.#link = link;
    this.#deviceID = deviceID;
    this.#jobs = jobs;
    this.#onChange = onChange;
    this.#onSettled = onSettled;
    this.#onHeard = onHeard;
    this.#now = now;
    this.#schedule = schedule;
    this.#cancel = cancel;
  }

  get sending() {
    return this.#sending;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#plan(0);
  }

  stop() {
    this.#running = false;
    this.#cancel(this.#timer);
    this.#timer = null;
    this.#due = Infinity;
  }

  /** Something has changed: send it soon. */
  poke() {
    // After a failure the next attempt keeps its place: asking more often
    // would not bring the connection back any sooner.
    if (this.failures === 0) this.#plan(600, true);
  }

  /** Try now, as when the connection is back or the user asks. */
  retryNow() {
    this.#plan(0);
  }

  /** Forgets what the hub is believed to hold, as when another key is entered. */
  forget() {
    this.#known.clear();
    this.failures = 0;
    this.turnedDown = false;
    this.problem = '';
  }

  /** How many results of a race the hub does not have in their present form. */
  waiting(race, station, timeZone) {
    const known = this.#known.get(keyOf(race)) ?? null;
    if (!known) return race.crossings.length;
    const push = planPush(race, station, timeZone, known);
    return push.crossings.length + push.deleted.length;
  }

  /**
   * How many results the hub holds from this iPad for a race that the iPad
   * itself does not have (any more); 0 if that is not known. They are left
   * where they are.
   */
  extra(race) {
    return this.#known.get(keyOf(race))?.extra ?? 0;
  }

  #plan(delay, onlySooner = false) {
    if (!this.#running) return;
    const due = this.#now() + delay;
    if (onlySooner && this.#timer !== null && this.#due <= due) return;
    this.#cancel(this.#timer);
    this.#due = due;
    this.#timer = this.#schedule(() => {
      this.#timer = null;
      this.#due = Infinity;
      this.#attempt();
    }, delay);
  }

  /** The upload to make now, if any: { job, push, known }. */
  #work() {
    const jobs = this.#jobs();
    for (const [index, job] of jobs.entries()) {
      const known = this.#known.get(keyOf(job.race)) ?? null;
      const push = planPush(job.race, job.station, job.timeZone, known);
      if (hasChanges(push, known)) return { job, push, known };
      // Only the race in use checks in when it has nothing new.
      if (index === 0 && this.#now() - this.#lastContact >= checkInEvery) return { job, push, known };
      this.#onSettled(job.race);
    }
    return null;
  }

  async #attempt() {
    if (!this.#running || this.#sending) return;
    if (!this.#link.key) return;
    const work = this.#work();
    if (!work) {
      this.#plan(Math.max(1000, checkInEvery - (this.#now() - this.#lastContact)));
      return;
    }
    const { job, push, known } = work;
    const code = job.race.code;
    this.#sending = true;
    this.#onChange();
    try {
      const body = JSON.stringify(push);
      const reply = await this.#link.json(`/api/events/${encodeURIComponent(code)}/sources/${encodeURIComponent(this.#deviceID)}`, {
        method: 'PUT', body, headers: { 'Content-Type': 'application/json' },
      });
      this.bytes += body.length + overheadBytes;
      this.#lastContact = this.#now();
      // The hub has heard of these deletions; the race need not remember them.
      if (push.deleted.length > 0 && Array.isArray(job.race.deleted) && job.race.deleted.length > 0) {
        const heard = new Set(push.deleted);
        job.race.deleted = job.race.deleted.filter((id) => !heard.has(id));
        this.#onHeard(job.race);
      }
      const after = stateAfter(push, reply, known);
      if (after) {
        this.#known.set(keyOf(job.race), after);
      } else {
        this.#known.delete(keyOf(job.race));
        if (!known) {
          // The hub was sent everything and holds less than that: it has
          // refused some. Sending it all again at once would only use up data.
          throw new Failure(`The results site kept only ${reply.count} of the ${push.crossings.length} results it was sent.`, 409);
        }
      }
      this.failures = 0;
      this.turnedDown = false;
      this.problem = '';
      this.lastSuccess = this.#now();
      // Look again at once: something may have changed meanwhile, the hub
      // may need everything sent again, or another race may be waiting.
      this.#plan(after ? 200 : 0);
    } catch (error) {
      this.failures += 1;
      this.problem = error instanceof Failure ? error.message : `The upload failed (${error.message}).`;
      this.turnedDown = error instanceof Failure && error.turnedDown;
      const [first, most] = this.turnedDown ? [30_000, 300_000] : [2000, 30_000];
      this.#plan(Math.min(most, first * 2 ** Math.min(this.failures - 1, 6)));
    } finally {
      this.#sending = false;
      this.#onChange();
    }
  }

  /**
   * Hands what has not been sent to the browser to send, without waiting
   * for the answer: for the moment the page is put away. Only small
   * uploads can be sent this way.
   */
  sendOff() {
    if (!this.#running || this.#sending || !this.#link.key) return;
    const [job] = this.#jobs();
    if (!job) return;
    const known = this.#known.get(keyOf(job.race)) ?? null;
    const push = planPush(job.race, job.station, job.timeZone, known);
    if (!hasChanges(push, known)) return;
    const body = JSON.stringify(push);
    if (body.length > 60_000) return;
    // What the hub holds after this is not known until it is next asked.
    this.#known.delete(keyOf(job.race));
    this.#link.json(`/api/events/${encodeURIComponent(job.race.code)}/sources/${encodeURIComponent(this.#deviceID)}`, {
      method: 'PUT', body, headers: { 'Content-Type': 'application/json' }, keepalive: true,
    }).catch(() => {});
  }
}

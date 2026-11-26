// What the capture page keeps on the iPad: the settings, the races with
// their results, and a small picture of each recorded bib.
//
// Settings and results are kept as one piece of text in the browser's local
// storage, written a moment after each change and whenever the page is put
// away. Pictures go into the browser's database, which takes larger things.

import { defaultRules } from './lib/bibfilter.js';
import { standardLine, wholePicture } from './lib/geometry.js';
import { defaultRepeatRule, newID } from './lib/ledger.js';

const stateKey = 'bibtimer.capture.v1';
export const keyStorage = 'bibtimer.hub.key'; // shared with the results page

export function defaultSettings() {
  return {
    // The place name last given to this iPad; offered again for the next race.
    station: 'Finish',
    timingMode: 'line',
    line: { a: { ...standardLine.a }, b: { ...standardLine.b }, reversed: false },
    // The part of the picture that is searched for bibs.
    scanZone: { ...wholePicture },
    rules: defaultRules(),
    minSightings: 2,
    repeatRule: defaultRepeatRule(),
    // How large the picture is when text is looked for: 'fast', 'standard' or
    // 'far', or 'auto' to go by how many processor cores the reader has.
    detail: 'auto',
    // How long before a picture reaches the page the camera took it, in
    // milliseconds, where the browser does not say.
    cameraDelay: 60,
    savePhotos: true,
    zoom: null,
    cameraID: null,
    // Processor cores the reader uses; 0 leaves the choice to the page.
    threads: 0,
  };
}

/** Fills in whatever a saved object lacks from the defaults, one level down as well. */
function withDefaults(saved, defaults) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
  const result = { ...defaults };
  for (const [name, fallback] of Object.entries(defaults)) {
    const value = saved[name];
    if (value === undefined || value === null && fallback !== null) continue;
    if (fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)) result[name] = withDefaults(value, fallback);
    else if (fallback === null || typeof value === typeof fallback) result[name] = value;
  }
  return result;
}

/**
 * A race as it is kept on the iPad. `station` is written on every result, so
 * that the iPads at an event can be told apart; `unsent` is true while the
 * results site may not have all of its results; `deleted` holds the
 * identifiers of results deleted here until the site has heard of it.
 */
export function newRace(name, code, station, createdAt) {
  return { id: newID(), name, code, station, createdAt, startTime: null, crossings: [], deleted: [], roster: [], restrictToRoster: false, unsent: false };
}

function cleanRace(saved) {
  if (saved === null || typeof saved !== 'object' || typeof saved.id !== 'string' || typeof saved.code !== 'string') return null;
  return {
    id: saved.id,
    name: typeof saved.name === 'string' && saved.name !== '' ? saved.name : 'Race',
    code: saved.code,
    station: typeof saved.station === 'string' ? saved.station : '',
    createdAt: Number(saved.createdAt) || 0,
    startTime: typeof saved.startTime === 'number' ? saved.startTime : null,
    crossings: Array.isArray(saved.crossings) ? saved.crossings.filter((crossing) => crossing && typeof crossing.id === 'string' && typeof crossing.time === 'number') : [],
    // Results deleted on this iPad that the results site may not have heard about yet.
    deleted: Array.isArray(saved.deleted) ? saved.deleted.filter((id) => typeof id === 'string') : [],
    roster: Array.isArray(saved.roster) ? saved.roster.filter((entry) => entry && typeof entry.bib === 'string') : [],
    restrictToRoster: saved.restrictToRoster === true,
    // Whatever was the case when the page was closed, the results site is asked afresh.
    unsent: saved.unsent === true,
  };
}

export class Storage {
  #timer = null;
  #due = Infinity;
  #problem = null;

  constructor() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(stateKey) ?? 'null');
    } catch {
      // Unreadable, or the browser keeps nothing (private browsing): start afresh.
    }
    this.deviceID = typeof saved?.deviceID === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(saved.deviceID) ? saved.deviceID : newID();
    this.settings = withDefaults(saved?.settings, defaultSettings());
    this.races = (Array.isArray(saved?.races) ? saved.races : []).map(cleanRace).filter((race) => race !== null);
    this.currentRaceID = this.races.some((race) => race.id === saved?.currentRaceID) ? saved.currentRaceID : null;
    // Set while results are being recorded: { raceID, since }. If the page
    // is reloaded meanwhile (Safari does that to pages it has put away),
    // recording is switched on again.
    const resume = saved?.resume;
    this.resume = resume && typeof resume.raceID === 'string' && typeof resume.since === 'number' ? { raceID: resume.raceID, since: resume.since } : null;
    window.addEventListener('pagehide', () => this.saveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveNow();
    });
  }

  get race() {
    return this.races.find((race) => race.id === this.currentRaceID) ?? null;
  }

  /** What went wrong the last time something was written, if anything. */
  get problem() {
    return this.#problem;
  }

  /**
   * Writes soon; many changes in a row are written once.
   *
   * @param {number} within milliseconds; longer for changes that would be no loss
   */
  save(within = 250) {
    const due = Date.now() + within;
    if (this.#timer !== null && this.#due <= due) return;
    clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(() => this.saveNow(), within);
  }

  saveNow() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#due = Infinity;
    try {
      localStorage.setItem(stateKey, JSON.stringify({
        deviceID: this.deviceID, settings: this.settings, races: this.races, currentRaceID: this.currentRaceID, resume: this.resume,
      }));
      this.#problem = null;
    } catch (error) {
      this.#problem = `Results can no longer be saved on this iPad (${error.message}). They are still sent to the results site, so keep this page open. ` +
        'To make room, clear old races off the iPad (Race → Another race…).';
    }
  }

  // ---- Pictures ----

  #database = null;

  #open() {
    if (this.#database) return this.#database;
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open('bibtimer-capture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('photos');
      request.onsuccess = () => {
        const database = request.result;
        // Safari has been known to drop the connection while a page is in
        // the background. It is then opened again the next time.
        const forget = () => {
          this.#database = null;
        };
        database.onclose = forget;
        database.onversionchange = () => {
          database.close();
          forget();
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
    // A browser that keeps no database simply keeps no pictures.
    this.#database.catch(() => {});
    return this.#database;
  }

  async #photos(mode, work) {
    try {
      const database = await this.#open();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('photos', mode);
        const request = work(transaction.objectStore('photos'));
        transaction.oncomplete = () => resolve(request?.result ?? null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch {
      // Whatever went wrong, a fresh connection is tried next time.
      this.#database = null;
      return null;
    }
  }

  /**
   * Keeps a picture. It is kept as plain bytes: Safari does not take
   * pictures as such into its database in every mode (not in private
   * browsing, for one).
   */
  async savePhoto(id, blob) {
    let bytes;
    try {
      bytes = await blob.arrayBuffer();
    } catch {
      return null;
    }
    return this.#photos('readwrite', (store) => store.put({ type: blob.type || 'image/jpeg', bytes }, id));
  }

  /** The picture kept under this identifier, or null. */
  async photo(id) {
    const kept = await this.#photos('readonly', (store) => store.get(id));
    if (!kept) return null;
    if (kept instanceof Blob) return kept;
    return kept.bytes ? new Blob([kept.bytes], { type: kept.type || 'image/jpeg' }) : null;
  }

  deletePhotos(ids) {
    return this.#photos('readwrite', (store) => {
      for (const id of ids) store.delete(id);
      return null;
    });
  }
}

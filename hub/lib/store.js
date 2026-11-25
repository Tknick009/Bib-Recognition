// Holds the results the iPads have sent, in memory, with a copy on disk.
//
// Layout: an event (one race, identified by a short code) has one "source" per
// iPad, and each source holds that iPad's crossings. An iPad either sends its
// whole list (which replaces what the hub had from it) or just what changed.
//
// The iPads keep the master copy. If the hub ever loses its data it gets a new
// store identity, each iPad notices on its next upload and sends everything
// again. So nothing here has to be treated as irreplaceable.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const limits = {
  events: 500,
  sourcesPerEvent: 60,
  crossingsPerSource: 50_000,
};

const eventCodePattern = /^[a-z0-9](?:[a-z0-9-]{1,48})[a-z0-9]$/;
const devicePattern = /^[A-Za-z0-9-]{8,64}$/;
const idPattern = /^[A-Za-z0-9-]{1,64}$/;
const timings = new Set(['line', 'estimated', 'firstSeen', 'lastSeen', 'manual']);
const latestTime = 4_102_444_800; // 2100-01-01, in seconds

export function isEventCode(code) {
  return typeof code === 'string' && eventCodePattern.test(code);
}

export function isDeviceID(device) {
  return typeof device === 'string' && devicePattern.test(device);
}

function text(value, maxLength) {
  if (typeof value !== 'string') return '';
  // Control characters have no business in a name or a note.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function numberOrNull(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** A crossing as sent by an iPad, reduced to the fields the hub keeps; null if unusable. */
export function cleanCrossing(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) return null;
  const time = numberOrNull(raw.time, 0, latestTime);
  if (time === null) return null;
  return {
    id: raw.id,
    bib: text(raw.bib, 16),
    time,
    timing: timings.has(raw.timing) ? raw.timing : 'manual',
    source: raw.source === 'camera' ? 'camera' : 'manual',
    clock: raw.clock === 'ntp' ? 'ntp' : 'device',
    clockError: numberOrNull(raw.clockError, 0, 86_400),
    confidence: numberOrNull(raw.confidence, 0, 1),
    note: text(raw.note, 200),
  };
}

export class Store {
  #dataDir;
  #now;
  #log;
  #events = new Map();
  #storeID = randomUUID();
  #pendingSaves = new Map();

  /**
   * @param {object} options
   * @param {string|null} options.dataDir where to keep a copy on disk; null keeps results in memory only
   * @param {() => number} options.now the current time in milliseconds
   */
  constructor({ dataDir = null, now = () => Date.now(), log = () => {} } = {}) {
    this.#dataDir = dataDir;
    this.#now = now;
    this.#log = log;
    if (dataDir) this.#load();
  }

  /** Changes whenever the hub has lost what it held. */
  get storeID() {
    return this.#storeID;
  }

  get persistent() {
    return this.#dataDir !== null;
  }

  // ---- Reading ----

  listEvents() {
    return [...this.#events.values()]
      .map((event) => this.#summary(event))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  hasEvent(code) {
    return this.#events.has(code);
  }

  revision(code) {
    return this.#events.get(code)?.revision ?? 0;
  }

  /**
   * The merged results of an event, in finishing order.
   *
   * @param {string} code
   * @param {object} options
   * @param {string[]|null} options.stations only these station names (case-insensitive)
   * @param {string[]|null} options.devices only these iPads, by device identifier
   * @param {boolean} options.firstPerBib keep only the earliest crossing of each bib
   */
  results(code, { stations = null, devices = null, firstPerBib = false } = {}) {
    const event = this.#events.get(code);
    if (!event) return null;
    const wanted = stations ? new Set(stations.map((name) => name.toLowerCase())) : null;
    const wantedDevices = devices ? new Set(devices) : null;

    let rows = [];
    for (const source of event.sources.values()) {
      if (wanted && !wanted.has(source.station.toLowerCase())) continue;
      if (wantedDevices && !wantedDevices.has(source.device)) continue;
      for (const crossing of source.crossings.values()) {
        rows.push({ ...crossing, station: source.station, device: source.device });
      }
    }
    rows.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (firstPerBib) {
      const seen = new Set();
      rows = rows.filter((row) => {
        if (row.bib === '') return true;
        if (seen.has(row.bib)) return false;
        seen.add(row.bib);
        return true;
      });
    }
    return { ...this.#summary(event), rows };
  }

  // ---- Writing ----

  /**
   * Takes in what one iPad sent about one event.
   * Returns `{ store, count }`, or `{ error }` if a limit would be exceeded.
   */
  applyPush(code, device, push) {
    const now = this.#now();
    let event = this.#events.get(code);
    if (!event) {
      if (this.#events.size >= limits.events) return { error: 'The hub is holding too many events. Delete old ones.' };
      event = { code, createdAt: now, updatedAt: now, revision: 0, sources: new Map() };
      this.#events.set(code, event);
    }

    let source = event.sources.get(device);
    if (!source) {
      if (event.sources.size >= limits.sourcesPerEvent) return { error: 'Too many iPads have sent results for this event.' };
      source = {
        device, station: '', raceName: '', timeZone: 'UTC',
        startTime: null, startChangedAt: 0, updatedAt: now, crossings: new Map(),
      };
      event.sources.set(device, source);
    }

    const crossings = Array.isArray(push.crossings) ? push.crossings : [];
    const deleted = Array.isArray(push.deleted) ? push.deleted : [];
    const next = push.full === true ? new Map() : new Map(source.crossings);
    for (const raw of crossings) {
      const crossing = cleanCrossing(raw);
      if (crossing) next.set(crossing.id, crossing);
    }
    for (const id of deleted) {
      if (typeof id === 'string') next.delete(id);
    }
    if (next.size > limits.crossingsPerSource) return { error: 'Too many results from one iPad.' };
    source.crossings = next;

    source.station = text(push.station, 40) || 'Station';
    source.raceName = text(push.raceName, 80);
    if (typeof push.timeZone === 'string' && push.timeZone.length <= 64) source.timeZone = push.timeZone;
    const startTime = numberOrNull(push.startTime, 0, latestTime);
    if (startTime !== source.startTime) {
      source.startTime = startTime;
      source.startChangedAt = now;
    }
    source.updatedAt = now;
    event.updatedAt = now;
    event.revision += 1;
    this.#scheduleSave(code);
    return { store: this.#storeID, count: source.crossings.size };
  }

  deleteEvent(code) {
    if (!this.#events.delete(code)) return false;
    this.#cancelSave(code);
    if (this.#dataDir) {
      try {
        fs.rmSync(this.#eventFile(code), { force: true });
      } catch (error) {
        this.#log(`could not remove the saved copy of ${code}: ${error.message}`);
      }
    }
    return true;
  }

  // ---- Summaries ----

  #summary(event) {
    const sources = [...event.sources.values()];
    // The start time in force is the one that was set most recently on any iPad.
    const starter = sources
      .filter((source) => source.startTime !== null)
      .sort((a, b) => b.startChangedAt - a.startChangedAt)[0];
    const named = sources.find((source) => source.raceName !== '');
    return {
      code: event.code,
      name: named ? named.raceName : event.code,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      revision: event.revision,
      startTime: starter ? starter.startTime : null,
      startFrom: starter ? starter.station : null,
      timeZone: this.#timeZone(sources),
      count: sources.reduce((sum, source) => sum + source.crossings.size, 0),
      stations: sources
        .map((source) => ({
          station: source.station,
          device: source.device,
          count: source.crossings.size,
          updatedAt: source.updatedAt,
          startTime: source.startTime,
        }))
        .sort((a, b) => a.station.localeCompare(b.station) || a.device.localeCompare(b.device)),
    };
  }

  /** The time zone to show times in: the one most iPads at this event are set to. */
  #timeZone(sources) {
    const votes = new Map();
    for (const source of sources) votes.set(source.timeZone, (votes.get(source.timeZone) ?? 0) + 1);
    let best = 'UTC';
    let bestVotes = 0;
    for (const [zone, count] of [...votes].sort(([a], [b]) => a.localeCompare(b))) {
      if (count > bestVotes) {
        best = zone;
        bestVotes = count;
      }
    }
    return best;
  }

  // ---- Disk ----

  #eventFile(code) {
    return path.join(this.#dataDir, 'events', `${code}.json`);
  }

  #load() {
    try {
      fs.mkdirSync(path.join(this.#dataDir, 'events'), { recursive: true });
    } catch (error) {
      this.#log(`cannot use ${this.#dataDir} (${error.message}); results will be kept in memory only`);
      this.#dataDir = null;
      return;
    }

    const identityFile = path.join(this.#dataDir, 'store.json');
    try {
      const saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (typeof saved.store === 'string' && saved.store.length > 0) this.#storeID = saved.store;
    } catch {
      // First start with this directory: keep the new identity.
    }
    try {
      this.#writeFile(identityFile, JSON.stringify({ store: this.#storeID }));
    } catch (error) {
      this.#log(`cannot write to ${this.#dataDir} (${error.message}); results will be kept in memory only`);
      this.#dataDir = null;
      return;
    }

    for (const name of fs.readdirSync(path.join(this.#dataDir, 'events'))) {
      if (!name.endsWith('.json')) continue;
      const code = name.slice(0, -'.json'.length);
      if (!isEventCode(code)) continue;
      try {
        const saved = JSON.parse(fs.readFileSync(this.#eventFile(code), 'utf8'));
        this.#events.set(code, this.#revive(code, saved));
      } catch (error) {
        this.#log(`skipping unreadable event file ${name}: ${error.message}`);
      }
    }
  }

  #revive(code, saved) {
    const event = {
      code,
      createdAt: Number(saved.createdAt) || this.#now(),
      updatedAt: Number(saved.updatedAt) || this.#now(),
      revision: Number(saved.revision) || 0,
      sources: new Map(),
    };
    for (const raw of Array.isArray(saved.sources) ? saved.sources : []) {
      if (!isDeviceID(raw?.device)) continue;
      const crossings = new Map();
      for (const item of Array.isArray(raw.crossings) ? raw.crossings : []) {
        const crossing = cleanCrossing(item);
        if (crossing) crossings.set(crossing.id, crossing);
      }
      event.sources.set(raw.device, {
        device: raw.device,
        station: text(raw.station, 40) || 'Station',
        raceName: text(raw.raceName, 80),
        timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : 'UTC',
        startTime: numberOrNull(raw.startTime, 0, latestTime),
        startChangedAt: Number(raw.startChangedAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
        crossings,
      });
    }
    return event;
  }

  #serialize(event) {
    return JSON.stringify({
      code: event.code,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      revision: event.revision,
      sources: [...event.sources.values()].map((source) => ({
        ...source,
        crossings: [...source.crossings.values()],
      })),
    });
  }

  #scheduleSave(code) {
    if (!this.#dataDir || this.#pendingSaves.has(code)) return;
    const timer = setTimeout(() => {
      this.#pendingSaves.delete(code);
      this.#save(code);
    }, 250);
    timer.unref();
    this.#pendingSaves.set(code, timer);
  }

  #cancelSave(code) {
    const timer = this.#pendingSaves.get(code);
    if (timer) clearTimeout(timer);
    this.#pendingSaves.delete(code);
  }

  #save(code) {
    const event = this.#events.get(code);
    if (!event || !this.#dataDir) return;
    try {
      this.#writeFile(this.#eventFile(code), this.#serialize(event));
    } catch (error) {
      this.#log(`could not save ${code}: ${error.message}`);
    }
  }

  /** Writes a file so that a crash mid-write cannot leave it half written. */
  #writeFile(file, contents) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
  }

  /** Writes everything that is waiting to be saved. Call before exiting. */
  flush() {
    for (const code of [...this.#pendingSaves.keys()]) {
      this.#cancelSave(code);
      this.#save(code);
    }
  }
}

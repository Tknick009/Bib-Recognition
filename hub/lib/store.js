// Holds the results the iPads have sent, in memory, with a copy on disk.
//
// Layout: an event (one race, identified by a short code) has one "source" per
// iPad, and each source holds that iPad's crossings. An iPad either sends its
// whole list (which replaces what the hub had from it) or just what changed.
//
// The iPads keep the master copy. If the hub ever loses its data it gets a new
// store identity, each iPad notices on its next upload and sends everything
// again. So nothing here has to be treated as irreplaceable.
//
// Every change to an event's results gives the event a new revision number,
// and each crossing remembers the revision in which it last changed. A reader
// that already has revision N can therefore ask for just what happened since,
// instead of downloading everything again. An upload that changes nothing (an
// iPad checking in) does not create a revision.
//
// Besides the results as they stand, an event keeps a feed: an ordered list
// that only ever grows, for a program that passes results on one by one (to
// scoring software, say) and cannot take one back. A result joins the feed
// once it has stopped changing for a few seconds. If it is corrected or
// removed after that, the feed says so in a further entry.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const limits = {
  events: 500,
  sourcesPerEvent: 60,
  crossingsPerSource: 50_000,
  // How many removals an event remembers, so readers can be told about them.
  removalsPerEvent: 20_000,
  // How many feed entries an event keeps before the oldest are dropped.
  feedEntries: 200_000,
};

const eventCodePattern = /^[a-z0-9](?:[a-z0-9-]{1,48})[a-z0-9]$/;
const devicePattern = /^[A-Za-z0-9-]{8,64}$/;
const idPattern = /^[A-Za-z0-9-]{1,64}$/;
const timings = new Set(['line', 'estimated', 'firstSeen', 'lastSeen', 'manual']);
const latestTime = 4_102_444_800; // 2100-01-01, in seconds
const crossingFields = ['bib', 'time', 'timing', 'source', 'clock', 'clockError', 'confidence', 'note'];

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

function wholeNumber(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
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

function sameCrossing(a, b) {
  return crossingFields.every((field) => a[field] === b[field]);
}

/** What a crossing looked like when it went into the feed; null if unusable. */
function cleanFed(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const time = numberOrNull(raw.time, 0, latestTime);
  if (time === null || typeof raw.bib !== 'string') return null;
  return { bib: text(raw.bib, 16), time };
}

/** True if two times are the same to the millisecond. */
function sameMoment(a, b) {
  return Math.round(a * 1000) === Math.round(b * 1000);
}

function byTimeThenID(a, b) {
  return a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

  /** Counts changes to the event's results. */
  revision(code) {
    return this.#events.get(code)?.revision ?? 0;
  }

  /** When any iPad at the event last got in touch, in milliseconds. */
  lastHeard(code) {
    return this.#events.get(code)?.updatedAt ?? 0;
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
    const labels = this.#labels(event);
    const chosen = this.#chooser(labels, stations, devices);

    let rows = [];
    // The iPads the rows come from, by label.
    const included = [];
    for (const source of event.sources.values()) {
      if (!chosen(source)) continue;
      included.push(labels.get(source.device));
      for (const crossing of source.crossings.values()) {
        rows.push(this.#row(crossing, source, labels));
      }
    }
    rows.sort(byTimeThenID);

    if (firstPerBib) {
      const seen = new Set();
      rows = rows.filter((row) => {
        if (row.bib === '') return true;
        if (seen.has(row.bib)) return false;
        seen.add(row.bib);
        return true;
      });
    }
    return { ...this.#summary(event), included, rows };
  }

  /**
   * What has happened to an event's results since a revision the reader
   * already has: the crossings that are new or different, and the identifiers
   * of those that are gone. Without a usable `since`, everything is returned
   * and `full` is true.
   */
  changes(code, since = null) {
    const event = this.#events.get(code);
    if (!event) return null;
    const full = !(Number.isInteger(since) && since >= event.removedFloor && since <= event.revision);

    const labels = this.#labels(event);
    const rows = [];
    for (const source of event.sources.values()) {
      for (const crossing of source.crossings.values()) {
        if (full || crossing.rev > since) rows.push(this.#row(crossing, source, labels));
      }
    }
    rows.sort(byTimeThenID);

    const removed = [];
    if (!full) {
      for (const [id, revision] of event.removed) {
        if (revision > since) removed.push(id);
      }
    }
    return { ...this.#summary(event), full, rows, removed };
  }

  /** A crossing as readers get it: with the name of the iPad it came from. */
  #row(crossing, source, labels) {
    const { fed, at, ...fields } = crossing;
    return { ...fields, station: labels.get(source.device), device: source.device };
  }

  /**
   * Which iPads a reader asked for: by station name or label (in any letter
   * case) and/or by device identifier. Without either, all of them.
   */
  #chooser(labels, stations, devices) {
    const names = stations ? new Set(stations.map((name) => name.toLowerCase())) : null;
    const ids = devices ? new Set(devices) : null;
    return (source) => {
      if (names && !names.has(source.station.toLowerCase()) && !names.has(labels.get(source.device).toLowerCase())) return false;
      if (ids && !ids.has(source.device)) return false;
      return true;
    };
  }

  // ---- The feed ----

  /**
   * The feed entries after number `after`, oldest first.
   *
   * Looking is what makes results join the feed: each result that has a bib
   * number and has not changed for `settle` seconds gets an entry, once. The
   * wait covers the camera correcting a number while the bib is still in
   * view. A result that changes after its entry gets another one, which says
   * what it was before (`was`); one that is removed gets an entry of kind
   * "gone".
   *
   * @param {string} code
   * @param {object} options
   * @param {number} options.after the last entry the reader has dealt with
   * @param {string|null} options.feedID the feed that number belongs to; a reader
   *   that last read another feed (the hub or the event has started afresh
   *   since) is given everything from the beginning
   * @param {number} options.settle seconds a result must have been unchanged
   * @param {number} options.limit most entries to return at once
   */
  feed(code, { after = 0, feedID = null, settle = 8, stations = null, devices = null, limit = 500 } = {}) {
    const event = this.#events.get(code);
    if (!event) return null;
    this.#fillFeed(event, settle);

    const last = event.feedFloor + event.feed.length;
    let from = Number.isInteger(after) && after > 0 ? after : 0;
    // A reader ahead of the feed cannot have read this feed: start it over.
    if (feedID !== event.feedID || from > last) from = 0;
    from = Math.max(from, event.feedFloor);

    const labels = this.#labels(event);
    const chosen = this.#chooser(labels, stations, devices);
    const entries = [];
    let next = from;
    for (let index = from - event.feedFloor; index < event.feed.length && entries.length < limit; index += 1) {
      const entry = event.feed[index];
      next = entry.seq;
      const source = event.sources.get(entry.device);
      if (!source || !chosen(source)) continue;
      entries.push({ ...entry, station: labels.get(entry.device) });
    }
    const summary = this.#summary(event);
    return { feedID: event.feedID, next, entries, timeZone: summary.timeZone, startTime: summary.startTime };
  }

  /** Gives every result that is due one an entry in the feed. */
  #fillFeed(event, settle) {
    const settledBefore = this.#now() - Math.max(0, settle) * 1000;
    const due = [];
    for (const source of event.sources.values()) {
      for (const crossing of source.crossings.values()) {
        const fed = crossing.fed;
        const unchanged = fed && fed.bib === crossing.bib && sameMoment(fed.time, crossing.time);
        if (unchanged || (crossing.at ?? 0) > settledBefore) continue;
        // Without a number there is nothing to pass on, but if a number was
        // passed on earlier, the reader has to hear that it no longer holds.
        if (crossing.bib === '' && !fed) continue;
        due.push({ source, crossing });
      }
    }
    if (due.length === 0) return;

    due.sort((a, b) => byTimeThenID(a.crossing, b.crossing));
    for (const { source, crossing } of due) {
      if (crossing.bib === '') {
        this.#addToFeed(event, { kind: 'gone', device: source.device, id: crossing.id, was: crossing.fed });
        delete crossing.fed;
      } else {
        const entry = { kind: 'read', device: source.device, id: crossing.id, bib: crossing.bib, time: crossing.time };
        if (crossing.fed) entry.was = crossing.fed;
        this.#addToFeed(event, entry);
        crossing.fed = { bib: crossing.bib, time: crossing.time };
      }
    }
    this.#scheduleSave(event.code);
  }

  #addToFeed(event, entry) {
    event.feed.push({ seq: event.feedFloor + event.feed.length + 1, ...entry });
    if (event.feed.length > limits.feedEntries) {
      const drop = Math.floor(limits.feedEntries / 2);
      event.feed.splice(0, drop);
      event.feedFloor += drop;
    }
  }

  // ---- Writing ----

  /**
   * Takes in what one iPad sent about one event.
   * Returns `{ store, count }`, or `{ error }` if a limit would be exceeded.
   */
  applyPush(code, device, push) {
    const now = this.#now();
    // Nothing is stored until the whole upload has been checked, so an upload
    // that is refused leaves no trace.
    let event = this.#events.get(code);
    if (!event) {
      if (this.#events.size >= limits.events) return { error: 'The hub is holding too many events. Delete old ones.' };
      event = {
        code, createdAt: now, updatedAt: now, revision: 0, removed: new Map(), removedFloor: 0, sources: new Map(),
        feedID: randomUUID(), feed: [], feedFloor: 0,
      };
    }

    let source = event.sources.get(device);
    const isNewSource = !source;
    if (!source) {
      if (event.sources.size >= limits.sourcesPerEvent) return { error: 'Too many iPads have sent results for this event.' };
      source = {
        device, station: '', raceName: '', timeZone: 'UTC',
        startTime: null, startChangedAt: 0, joinedAt: now, updatedAt: now, crossings: new Map(),
      };
    }

    // The revision this upload gets, if it turns out to change anything.
    const revision = event.revision + 1;
    let changed = isNewSource;

    const next = push.full === true ? new Map() : new Map(source.crossings);
    for (const raw of Array.isArray(push.crossings) ? push.crossings : []) {
      const crossing = cleanCrossing(raw);
      if (!crossing) continue;
      const previous = source.crossings.get(crossing.id);
      if (previous && sameCrossing(previous, crossing)) {
        next.set(crossing.id, previous);
      } else {
        // `at` is when it last changed; `fed` what the feed has said about it.
        const stored = { ...crossing, rev: revision, at: now };
        if (previous?.fed) stored.fed = previous.fed;
        next.set(crossing.id, stored);
        changed = true;
      }
    }
    for (const id of Array.isArray(push.deleted) ? push.deleted : []) {
      if (typeof id === 'string') next.delete(id);
    }
    if (next.size > limits.crossingsPerSource) return { error: 'Too many results from one iPad.' };

    const gone = [...source.crossings.keys()].filter((id) => !next.has(id));
    if (gone.length > 0) changed = true;
    const goneAfterFeed = gone.map((id) => source.crossings.get(id)).filter((crossing) => crossing.fed);

    const station = text(push.station, 40) || 'Station';
    if (station !== source.station) {
      // Every row from this iPad is shown with its station name.
      for (const [id, crossing] of next) next.set(id, { ...crossing, rev: revision });
      changed = true;
    }
    const raceName = text(push.raceName, 80);
    const timeZone = typeof push.timeZone === 'string' && push.timeZone.length <= 64 ? push.timeZone : source.timeZone;
    const startTime = numberOrNull(push.startTime, 0, latestTime);
    if (raceName !== source.raceName || timeZone !== source.timeZone || startTime !== source.startTime) changed = true;

    // Nothing can fail from here on, so the upload is taken in as a whole.
    this.#events.set(code, event);
    event.sources.set(device, source);
    source.crossings = next;
    source.station = station;
    source.raceName = raceName;
    source.timeZone = timeZone;
    if (startTime !== source.startTime) {
      source.startTime = startTime;
      source.startChangedAt = now;
    }
    source.updatedAt = now;
    event.updatedAt = now;

    if (changed) {
      event.revision = revision;
      for (const id of gone) event.removed.set(id, revision);
      for (const id of next.keys()) event.removed.delete(id);
      this.#trimRemovals(event);
    }
    // Whoever has passed a result on has to hear that it has been removed.
    for (const crossing of goneAfterFeed) {
      this.#addToFeed(event, { kind: 'gone', device, id: crossing.id, was: crossing.fed });
    }
    // Saved even when nothing changed, so "last heard from" survives a restart.
    this.#scheduleSave(code);
    return { store: this.#storeID, count: source.crossings.size };
  }

  /** Forgets the oldest removals once there are too many to remember. */
  #trimRemovals(event) {
    if (event.removed.size <= limits.removalsPerEvent) return;
    const oldestFirst = [...event.removed].sort(([, a], [, b]) => a - b);
    const drop = oldestFirst.slice(0, oldestFirst.length - limits.removalsPerEvent / 2);
    for (const [id, revision] of drop) {
      event.removed.delete(id);
      // Readers older than this can no longer be told what was removed and
      // are sent everything instead.
      event.removedFloor = Math.max(event.removedFloor, revision);
    }
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
    const labels = this.#labels(event);
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
      startFrom: starter ? labels.get(starter.device) : null,
      timeZone: this.#timeZone(sources),
      count: sources.reduce((sum, source) => sum + source.crossings.size, 0),
      stations: sources
        .map((source) => ({
          // `station` is the name the iPad was given, which another iPad may
          // have too; `label` is that name made unique within the event.
          station: source.station,
          label: labels.get(source.device),
          device: source.device,
          count: source.crossings.size,
          updatedAt: source.updatedAt,
          startTime: source.startTime,
        }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.device.localeCompare(b.device)),
    };
  }

  /**
   * A name for each iPad that no other iPad at the event has. Two iPads both
   * called "Finish" become "Finish" and "Finish (2)", in the order in which
   * they first sent results, so the names do not swap when a third joins.
   */
  #labels(event) {
    const inOrder = [...event.sources.values()]
      .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || a.device.localeCompare(b.device));
    const taken = new Map();
    const labels = new Map();
    for (const source of inOrder) {
      const name = source.station.toLowerCase();
      const count = (taken.get(name) ?? 0) + 1;
      taken.set(name, count);
      labels.set(source.device, count === 1 ? source.station : `${source.station} (${count})`);
    }
    return labels;
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
      revision: wholeNumber(saved.revision),
      removed: new Map(),
      removedFloor: wholeNumber(saved.removedFloor),
      sources: new Map(),
      feedID: typeof saved.feedID === 'string' && saved.feedID !== '' ? saved.feedID : randomUUID(),
      feed: [],
      feedFloor: wholeNumber(saved.feedFloor),
    };
    for (const entry of Array.isArray(saved.removed) ? saved.removed : []) {
      if (Array.isArray(entry) && typeof entry[0] === 'string') event.removed.set(entry[0], wholeNumber(entry[1]));
    }
    for (const raw of Array.isArray(saved.sources) ? saved.sources : []) {
      if (!isDeviceID(raw?.device)) continue;
      const crossings = new Map();
      for (const item of Array.isArray(raw.crossings) ? raw.crossings : []) {
        const crossing = cleanCrossing(item);
        if (!crossing) continue;
        const stored = { ...crossing, rev: Math.min(wholeNumber(item.rev), event.revision), at: Number(item.at) || 0 };
        const fed = cleanFed(item.fed);
        if (fed) stored.fed = fed;
        crossings.set(crossing.id, stored);
      }
      event.sources.set(raw.device, {
        device: raw.device,
        station: text(raw.station, 40) || 'Station',
        raceName: text(raw.raceName, 80),
        timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : 'UTC',
        startTime: numberOrNull(raw.startTime, 0, latestTime),
        startChangedAt: Number(raw.startChangedAt) || 0,
        joinedAt: Number(raw.joinedAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
        crossings,
      });
    }
    for (const raw of Array.isArray(saved.feed) ? saved.feed : []) {
      const entry = this.#reviveFeedEntry(raw, event);
      if (entry) event.feed.push({ seq: event.feedFloor + event.feed.length + 1, ...entry });
    }
    return event;
  }

  #reviveFeedEntry(raw, event) {
    if (raw === null || typeof raw !== 'object') return null;
    if (!isDeviceID(raw.device) || typeof raw.id !== 'string' || !idPattern.test(raw.id)) return null;
    const was = cleanFed(raw.was);
    if (raw.kind === 'gone') return was ? { kind: 'gone', device: raw.device, id: raw.id, was } : null;
    const now = cleanFed(raw);
    if (raw.kind !== 'read' || !now || now.bib === '') return null;
    const entry = { kind: 'read', device: raw.device, id: raw.id, bib: now.bib, time: now.time };
    if (was) entry.was = was;
    return entry;
  }

  #serialize(event) {
    return JSON.stringify({
      code: event.code,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      revision: event.revision,
      removed: [...event.removed],
      removedFloor: event.removedFloor,
      sources: [...event.sources.values()].map((source) => ({
        ...source,
        crossings: [...source.crossings.values()],
      })),
      feedID: event.feedID,
      feedFloor: event.feedFloor,
      feed: event.feed.map(({ seq, ...entry }) => entry),
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

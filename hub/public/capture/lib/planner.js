// Works out what to send to the hub: everything, when it is not known what
// the hub holds, and otherwise only what has changed since the last upload
// the hub accepted. The capture page stays the master copy of its results.

import { localDate } from './format.js';

/** One result as it is sent to the hub. */
export function wireCrossing(crossing) {
  const wire = {
    id: crossing.id,
    bib: crossing.bib,
    // Whole milliseconds, as in every export. Finer digits would mean
    // nothing and only make each upload longer.
    time: Math.round(crossing.time * 1000) / 1000,
    timing: crossing.timing,
    source: crossing.source,
    clock: crossing.clock,
    note: crossing.note ?? '',
  };
  if (crossing.clockError != null) wire.clockError = Math.round(crossing.clockError * 10_000) / 10_000;
  if (crossing.confidence != null) wire.confidence = Math.round(crossing.confidence * 100) / 100;
  return wire;
}

/**
 * Whether the hub already has a result as it is now. How sure the reader was
 * is left out of the comparison: it creeps up while a bib stays in view, and
 * sending every result a second time for that alone would double the data
 * used. The hub keeps the figure it was first sent.
 */
function sameWire(a, b) {
  return a !== undefined && a.bib === b.bib && a.time === b.time && a.timing === b.timing && a.source === b.source &&
    a.clock === b.clock && a.clockError === b.clockError && a.note === b.note;
}

/**
 * The upload that brings the hub up to date with a race.
 *
 * @param {object} race { name, startTime (seconds or null), crossings }
 * @param {string} station this iPad's station name
 * @param {string} timeZone e.g. "America/New_York"
 * @param {object|null} known what the hub is believed to hold (see `stateAfter`); null if that is not known
 */
export function planPush(race, station, timeZone, known) {
  const current = race.crossings.map(wireCrossing);
  const push = { station, raceName: race.name, timeZone, full: true, crossings: current, deleted: [] };
  if (race.startTime != null) push.startTime = race.startTime;
  if (!known) return push;

  const ids = new Set(current.map((crossing) => crossing.id));
  push.full = false;
  push.crossings = current.filter((crossing) => !sameWire(known.crossings.get(crossing.id), crossing));
  push.deleted = [...known.crossings.keys()].filter((id) => !ids.has(id)).sort();
  return push;
}

/** True if the upload changes nothing on the hub except "last heard from". */
export function isCheckIn(push) {
  return !push.full && push.crossings.length === 0 && push.deleted.length === 0;
}

/** Whether an upload would change anything the hub shows. */
export function hasChanges(push, known) {
  if (!known) return true;
  return !isCheckIn(push) || push.station !== known.station || push.raceName !== known.raceName ||
    push.timeZone !== known.timeZone || (push.startTime ?? null) !== known.startTime;
}

/**
 * What the hub holds once it has accepted `push`; null if its answer shows
 * that it holds something else, in which case everything is to be sent again.
 *
 * @param {object} reply the hub's answer: { store, count }
 */
export function stateAfter(push, reply, known) {
  let crossings = new Map();
  if (!push.full) {
    // An upload of changes only makes sense on top of what it was worked out against.
    if (!known || known.store !== reply.store) return null;
    crossings = new Map(known.crossings);
  }
  for (const crossing of push.crossings) crossings.set(crossing.id, crossing);
  for (const id of push.deleted) crossings.delete(id);
  if (reply.count !== crossings.size) return null;
  return { store: reply.store, crossings, station: push.station, raceName: push.raceName, timeZone: push.timeZone, startTime: push.startTime ?? null };
}

// ---- Event codes ----

function slug(text) {
  let result = '';
  for (const character of String(text).toLowerCase()) {
    if (/[a-z0-9]/.test(character)) result += character;
    else if (result !== '' && !result.endsWith('-')) result += '-';
  }
  return result.replace(/^-+|-+$/g, '');
}

/**
 * The code under which an event's results are collected. Every iPad at the
 * event must use the same one. It is made from the race name and the date,
 * so iPads on which the race is given the same name on the same day agree
 * without any typing.
 */
export function eventCode(name, seconds, timeZone) {
  const day = localDate(seconds, timeZone).replaceAll('-', '');
  const words = slug(name);
  const base = words === '' ? 'race' : words.slice(0, 40).replace(/^-+|-+$/g, '');
  return `${base}-${day}`;
}

/** Tidies up a code that was typed in: lower case, hyphens between words. */
export function normalizedCode(text) {
  return slug(text).slice(0, 50).replace(/^-+|-+$/g, '');
}

/** 3 to 50 lower-case letters, digits and hyphens, not starting or ending with a hyphen. The hub applies the same rule. */
export function isValidCode(code) {
  return typeof code === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,48})[a-z0-9]$/.test(code);
}

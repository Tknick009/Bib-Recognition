import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanCrossing, isDeviceID, isEventCode, limits, Store } from '../lib/store.js';

const deviceA = 'AAAAAAAA-0000-4000-8000-000000000001';
const deviceB = 'BBBBBBBB-0000-4000-8000-000000000002';

function crossing(id, bib, time, extra = {}) {
  return { id, bib, time, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.01, confidence: 1, note: '', ...extra };
}

function push(station, crossings, extra = {}) {
  return { station, raceName: 'Spring 5K', timeZone: 'UTC', startTime: null, full: true, crossings, deleted: [], ...extra };
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
}

test('event codes and device identifiers are validated', () => {
  assert.equal(isEventCode('spring-5k-20261125'), true);
  assert.equal(isEventCode('ab'), false);
  assert.equal(isEventCode('Spring'), false);
  assert.equal(isEventCode('-spring'), false);
  assert.equal(isEventCode('../etc'), false);
  assert.equal(isEventCode('a'.repeat(51)), false);
  assert.equal(isDeviceID(deviceA), true);
  assert.equal(isDeviceID('short'), false);
  assert.equal(isDeviceID('../../../../etc/passwd'), false);
});

test('a crossing is reduced to known, sane fields', () => {
  assert.deepEqual(cleanCrossing(crossing('x1', '101', 1000.5)), {
    id: 'x1', bib: '101', time: 1000.5, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.01, confidence: 1, note: '',
  });
  const odd = cleanCrossing({ id: 'x2', bib: 5, time: 12, timing: 'sideways', source: 'psychic', clock: 'sundial', clockError: -1, confidence: 7, note: 'a\u0000b', extra: 'dropped' });
  assert.deepEqual(odd, { id: 'x2', bib: '', time: 12, timing: 'manual', source: 'manual', clock: 'device', clockError: null, confidence: null, note: 'a b' });

  assert.equal(cleanCrossing(null), null);
  assert.equal(cleanCrossing({ id: 'x', bib: '1' }), null);
  assert.equal(cleanCrossing({ id: 'x', time: Infinity }), null);
  assert.equal(cleanCrossing({ id: 'bad id!', time: 1 }), null);
  assert.equal(cleanCrossing({ id: 'x', time: '12' }), null);
});

test('a full upload replaces what an iPad sent before; a partial one adds to it', () => {
  const store = new Store();
  let reply = store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10), crossing('b', '2', 20)]));
  assert.deepEqual(reply, { store: store.storeID, count: 2 });

  reply = store.applyPush('race', deviceA, push('Finish', [crossing('c', '3', 30), crossing('a', '11', 10)], { full: false, deleted: ['b'] }));
  assert.equal(reply.count, 2);
  assert.deepEqual(store.results('race').rows.map((row) => [row.id, row.bib]), [['a', '11'], ['c', '3']]);

  reply = store.applyPush('race', deviceA, push('Finish', [crossing('z', '9', 5)]));
  assert.equal(reply.count, 1);
  assert.deepEqual(store.results('race').rows.map((row) => row.id), ['z']);
});

test('results from several iPads are merged in finishing order', () => {
  const store = new Store();
  store.applyPush('race', deviceA, push('Finish A', [crossing('a1', '7', 100), crossing('a2', '9', 300)]));
  store.applyPush('race', deviceB, push('Finish B', [crossing('b1', '8', 200), crossing('b2', '7', 101), crossing('b3', '', 250)]));

  const all = store.results('race');
  assert.deepEqual(all.rows.map((row) => `${row.bib}@${row.station}`), ['7@Finish A', '7@Finish B', '8@Finish B', '@Finish B', '9@Finish A']);
  assert.equal(all.count, 5);
  assert.deepEqual(all.stations.map((station) => [station.station, station.count]), [['Finish A', 2], ['Finish B', 3]]);

  assert.deepEqual(store.results('race', { stations: ['finish b'] }).rows.map((row) => row.id), ['b2', 'b1', 'b3']);
  assert.deepEqual(store.results('race', { devices: [deviceA] }).rows.map((row) => row.id), ['a1', 'a2']);
  assert.deepEqual(store.results('race', { devices: [] }).rows, []);
  // One row per bib: the earliest. Marks without a number are all kept.
  assert.deepEqual(store.results('race', { firstPerBib: true }).rows.map((row) => row.id), ['a1', 'b1', 'b3', 'a2']);
  assert.equal(store.results('nothing-here'), null);
});

test('two iPads with the same station name do not overwrite each other', () => {
  const store = new Store();
  store.applyPush('race', deviceA, push('Finish', [crossing('a1', '1', 10)]));
  store.applyPush('race', deviceB, push('Finish', [crossing('b1', '2', 20)]));
  assert.deepEqual(store.results('race').rows.map((row) => row.id), ['a1', 'b1']);
});

test('the start time most recently set on any iPad is the one in force', () => {
  let clock = 1000;
  const store = new Store({ now: () => clock });
  store.applyPush('race', deviceA, push('Start', [], { startTime: 500 }));
  assert.equal(store.results('race').startTime, 500);
  assert.equal(store.results('race').startFrom, 'Start');

  clock = 2000;
  store.applyPush('race', deviceB, push('Finish', [], { startTime: 510 }));
  assert.equal(store.results('race').startTime, 510);
  assert.equal(store.results('race').startFrom, 'Finish');

  // Sending the same value again is not a change.
  clock = 3000;
  store.applyPush('race', deviceA, push('Start', [], { startTime: 500 }));
  assert.equal(store.results('race').startTime, 510);

  clock = 4000;
  store.applyPush('race', deviceB, push('Finish', [], { startTime: null }));
  assert.equal(store.results('race').startTime, 500);
});

test('events are listed with the most recently updated first', () => {
  let clock = 1000;
  const store = new Store({ now: () => clock });
  store.applyPush('older', deviceA, push('Finish', [crossing('a', '1', 10)]));
  clock = 2000;
  store.applyPush('newer', deviceA, push('Finish', [crossing('b', '2', 20)], { raceName: 'Autumn 10K' }));
  const events = store.listEvents();
  assert.deepEqual(events.map((event) => event.code), ['newer', 'older']);
  assert.equal(events[0].name, 'Autumn 10K');
  assert.equal(events[0].count, 1);
  assert.equal(store.revision('newer'), 1);

  assert.equal(store.deleteEvent('older'), true);
  assert.equal(store.deleteEvent('older'), false);
  assert.deepEqual(store.listEvents().map((event) => event.code), ['newer']);
});

test('results survive a restart when a data folder is given', () => {
  const dataDir = temporaryDirectory();
  const first = new Store({ dataDir });
  first.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10.125), crossing('b', '2', 20)], { startTime: 5, timeZone: 'Europe/London' }));
  first.flush();

  const second = new Store({ dataDir });
  assert.equal(second.storeID, first.storeID);
  assert.equal(second.persistent, true);
  const results = second.results('race');
  assert.deepEqual(results.rows.map((row) => [row.id, row.bib, row.time]), [['a', '1', 10.125], ['b', '2', 20]]);
  assert.equal(results.startTime, 5);
  assert.equal(results.timeZone, 'Europe/London');
  assert.equal(results.name, 'Spring 5K');

  second.deleteEvent('race');
  assert.equal(new Store({ dataDir }).results('race'), null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a hub that has lost its data gets a new identity', () => {
  const a = temporaryDirectory();
  const b = temporaryDirectory();
  assert.notEqual(new Store({ dataDir: a }).storeID, new Store({ dataDir: b }).storeID);
  assert.notEqual(new Store().storeID, new Store().storeID);
  assert.equal(new Store().persistent, false);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('an unusable data folder falls back to memory', () => {
  const file = path.join(temporaryDirectory(), 'not-a-folder');
  fs.writeFileSync(file, 'x');
  const messages = [];
  const store = new Store({ dataDir: file, log: (message) => messages.push(message) });
  assert.equal(store.persistent, false);
  assert.equal(messages.length, 1);
  assert.equal(store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10)])).count, 1);
});

test('limits are enforced', () => {
  const store = new Store();
  const many = Array.from({ length: limits.crossingsPerSource + 1 }, (_, index) => crossing(`c${index}`, '1', index));
  assert.match(store.applyPush('race', deviceA, push('Finish', many)).error, /Too many results/);
  // The refused upload left no trace.
  assert.equal(store.results('race'), null);
  assert.deepEqual(store.listEvents(), []);

  store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10)]));
  assert.match(store.applyPush('race', deviceA, push('Finish', many)).error, /Too many results/);
  assert.deepEqual(store.results('race').rows.map((row) => row.id), ['a']);
  assert.equal(store.revision('race'), 1);
});

test('an iPad checking in does not count as a change to the results', () => {
  let clock = 1000;
  const store = new Store({ now: () => clock });
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10)]));
  assert.equal(store.revision('race'), 1);

  clock = 5000;
  // The same list again, and an upload with nothing in it: nothing is new.
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10)]));
  store.applyPush('race', deviceA, push('Finish', [], { full: false }));
  assert.equal(store.revision('race'), 1);
  // But the hub knows the iPad is still there.
  assert.equal(store.lastHeard('race'), 5000);
  assert.equal(store.results('race').stations[0].updatedAt, 5000);

  // A start time is a change even without new results.
  store.applyPush('race', deviceA, push('Finish', [], { full: false, startTime: 3 }));
  assert.equal(store.revision('race'), 2);
});

test('a reader can ask for what changed since the revision it has', () => {
  const store = new Store();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10), crossing('b', '2', 20)]));
  store.applyPush('race', deviceA, push('Finish', [crossing('c', '3', 30)], { full: false }));
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '11', 10)], { full: false, deleted: ['b'] }));
  assert.equal(store.revision('race'), 3);

  const everything = store.changes('race');
  assert.equal(everything.full, true);
  assert.deepEqual(everything.rows.map((row) => [row.id, row.bib]), [['a', '11'], ['c', '3']]);
  assert.deepEqual(everything.removed, []);

  const sinceFirst = store.changes('race', 1);
  assert.equal(sinceFirst.full, false);
  assert.equal(sinceFirst.revision, 3);
  assert.deepEqual(sinceFirst.rows.map((row) => [row.id, row.bib, row.station]), [['a', '11', 'Finish'], ['c', '3', 'Finish']]);
  assert.deepEqual(sinceFirst.removed, ['b']);

  const sinceSecond = store.changes('race', 2);
  assert.deepEqual(sinceSecond.rows.map((row) => row.id), ['a']);
  assert.deepEqual(sinceSecond.removed, ['b']);

  const upToDate = store.changes('race', 3);
  assert.equal(upToDate.full, false);
  assert.deepEqual(upToDate.rows, []);
  assert.deepEqual(upToDate.removed, []);

  // A revision the hub never had, or nonsense, gets everything.
  assert.equal(store.changes('race', 99).full, true);
  assert.equal(store.changes('race', -1).full, true);
  assert.equal(store.changes('race', 1.5).full, true);
  assert.equal(store.changes('nothing-here'), null);
});

test('a renamed station and a result that comes back are passed on correctly', () => {
  const store = new Store();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10), crossing('b', '2', 20)]));
  store.applyPush('race', deviceA, push('Finish A', [], { full: false }));
  assert.deepEqual(store.changes('race', 1).rows.map((row) => [row.id, row.station]), [['a', 'Finish A'], ['b', 'Finish A']]);

  store.applyPush('race', deviceA, push('Finish A', [], { full: false, deleted: ['b'] }));
  assert.deepEqual(store.changes('race', 2).removed, ['b']);
  store.applyPush('race', deviceA, push('Finish A', [crossing('b', '2', 20)], { full: false }));
  const changes = store.changes('race', 2);
  assert.deepEqual(changes.rows.map((row) => row.id), ['b']);
  assert.deepEqual(changes.removed, []);
});

test('revisions and removals survive a restart', () => {
  const dataDir = temporaryDirectory();
  const first = new Store({ dataDir });
  first.applyPush('race', deviceA, push('Finish', [crossing('a', '1', 10), crossing('b', '2', 20)]));
  first.applyPush('race', deviceA, push('Finish', [crossing('c', '3', 30)], { full: false, deleted: ['a'] }));
  first.flush();

  const second = new Store({ dataDir });
  assert.equal(second.revision('race'), 2);
  const changes = second.changes('race', 1);
  assert.equal(changes.full, false);
  assert.deepEqual(changes.rows.map((row) => row.id), ['c']);
  assert.deepEqual(changes.removed, ['a']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('when too many removals have piled up, old readers are sent everything', () => {
  const store = new Store();
  const total = limits.removalsPerEvent + 10;
  const many = Array.from({ length: total }, (_, index) => crossing(`c${index}`, '1', index));
  store.applyPush('race', deviceA, push('Finish', many.slice(0, limits.crossingsPerSource)));
  assert.equal(store.revision('race'), 1);
  // Everything is removed in one go.
  store.applyPush('race', deviceA, push('Finish', [crossing('keep', '9', 1)]));
  assert.equal(store.revision('race'), 2);
  // The hub could not keep all the removals, so it does not pretend to.
  assert.equal(store.changes('race', 1).full, true);
  assert.deepEqual(store.changes('race', 1).rows.map((row) => row.id), ['keep']);
  assert.equal(store.changes('race', 2).full, false);
});

// ---- Telling iPads apart ----

test('two iPads with the same station name are told apart, in the order they joined', () => {
  let now = 1_000_000;
  const store = new Store({ now: () => now });
  store.applyPush('race', deviceB, push('Finish', [crossing('b1', '7', 10.2)]));
  now += 5000;
  store.applyPush('race', deviceA, push('Finish', [crossing('a1', '7', 10.0)]));

  const all = store.results('race');
  assert.deepEqual(all.stations.map((station) => [station.device, station.station, station.label]), [
    [deviceB, 'Finish', 'Finish'],
    [deviceA, 'Finish', 'Finish (2)'],
  ]);
  assert.deepEqual(all.rows.map((row) => [row.id, row.station]), [['a1', 'Finish (2)'], ['b1', 'Finish']]);
  assert.deepEqual(all.included, ['Finish', 'Finish (2)']);
  // Rows as readers get them carry nothing of the hub's own bookkeeping.
  assert.deepEqual(Object.keys(all.rows[0]).sort(), [
    'bib', 'clock', 'clockError', 'confidence', 'device', 'id', 'note', 'rev', 'source', 'station', 'time', 'timing',
  ]);

  // The shared name means both; a label or a device means one.
  assert.deepEqual(store.results('race', { stations: ['finish'] }).rows.map((row) => row.id), ['a1', 'b1']);
  assert.deepEqual(store.results('race', { stations: ['FINISH (2)'] }).rows.map((row) => row.id), ['a1']);
  assert.deepEqual(store.results('race', { stations: ['Finish (2)'] }).included, ['Finish (2)']);
  assert.deepEqual(store.results('race', { devices: [deviceB] }).rows.map((row) => row.id), ['b1']);
  assert.deepEqual(store.changes('race', null).rows.map((row) => row.station), ['Finish (2)', 'Finish']);

  // A third iPad does not change the names of the first two, whatever its identifier.
  now += 5000;
  store.applyPush('race', '00000000-0000-4000-8000-000000000000', push('Finish', []));
  assert.deepEqual(store.results('race').stations.map((station) => station.label), ['Finish', 'Finish (2)', 'Finish (3)']);
  assert.equal(store.results('race').stations[1].device, deviceA);

  // Once an iPad has a name of its own, it simply has that name.
  store.applyPush('race', deviceA, push('Finish B', [crossing('a1', '7', 10.0)]));
  assert.deepEqual(store.results('race').stations.map((station) => station.label), ['Finish', 'Finish (2)', 'Finish B']);
});

// ---- The feed ----

/** A store with a clock the test moves, and shorthands for the feed. */
function feedSetup(options = {}) {
  const clock = { now: 1_000_000 };
  const store = new Store({ now: () => clock.now, ...options });
  const wait = (seconds) => { clock.now += seconds * 1000; };
  // What a reader that has dealt with everything up to `after` is given.
  const read = (after = 0, extra = {}) => store.feed('race', { after, feedID: store.feed('race', { after: 1e9 })?.feedID, ...extra });
  const brief = (entries) => entries.map((entry) => [entry.seq, entry.kind, entry.bib ?? null, entry.was?.bib ?? null]);
  return { clock, store, wait, read, brief };
}

test('a result joins the feed once it has been left alone for a few seconds', () => {
  const { store, wait, read } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '214', 100.25)]));

  wait(5);
  assert.deepEqual(read(0).entries, []);
  assert.equal(read(0).next, 0);

  wait(3);
  const first = read(0);
  assert.deepEqual(first.entries, [{ seq: 1, kind: 'read', device: deviceA, id: 'a', bib: '214', time: 100.25, station: 'Finish' }]);
  assert.equal(first.next, 1);
  assert.equal(first.timeZone, 'UTC');

  // It is passed on once.
  wait(60);
  assert.deepEqual(read(1).entries, []);
  assert.equal(read(1).next, 1);
  // A reader starting from nothing is given it again.
  assert.equal(read(0).entries.length, 1);
});

test('a number the camera corrects straight away goes out once, corrected', () => {
  const { store, wait, read, brief } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100)]));
  wait(4);
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '187', 100)], { full: false }));
  // Eight seconds after it first arrived, but only four after it last changed.
  wait(4);
  assert.deepEqual(read(0).entries, []);
  wait(4);
  assert.deepEqual(brief(read(0).entries), [[1, 'read', '187', null]]);
});

test('a result the camera withdraws straight away never goes out', () => {
  const { store, wait, read } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]));
  wait(2);
  store.applyPush('race', deviceA, push('Finish', [], { full: false, deleted: ['a'] }));
  wait(20);
  assert.deepEqual(read(0).entries.map((entry) => entry.bib), ['5']);
});

test('a correction after a result has gone out says what went out before', () => {
  const { store, wait, read, brief } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]));
  wait(10);
  assert.deepEqual(brief(read(0).entries), [[1, 'read', '87', null], [2, 'read', '5', null]]);

  // The operator corrects the number by hand a minute later.
  wait(60);
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '78', 100)], { full: false }));
  assert.deepEqual(read(2).entries, []);
  wait(8);
  const correction = read(2).entries;
  assert.deepEqual(correction, [
    { seq: 3, kind: 'read', device: deviceA, id: 'a', bib: '78', time: 100, was: { bib: '87', time: 100 }, station: 'Finish' },
  ]);

  // A corrected time (the iPad's clock was put right afterwards) is a correction too.
  store.applyPush('race', deviceA, push('Finish', [crossing('b', '5', 103.5)], { full: false }));
  wait(8);
  assert.deepEqual(read(3).entries, [
    { seq: 4, kind: 'read', device: deviceA, id: 'b', bib: '5', time: 103.5, was: { bib: '5', time: 101 }, station: 'Finish' },
  ]);

  // A change that is neither (a note, say) is nothing to pass on.
  store.applyPush('race', deviceA, push('Finish', [crossing('b', '5', 103.5, { note: 'limping' })], { full: false }));
  wait(60);
  assert.deepEqual(read(4).entries, []);
});

test('a result removed after it has gone out is reported at once', () => {
  const { store, wait, read } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]));
  wait(10);
  assert.equal(read(0).next, 2);

  store.applyPush('race', deviceA, push('Finish', [], { full: false, deleted: ['a'] }));
  assert.deepEqual(read(2).entries, [
    { seq: 3, kind: 'gone', device: deviceA, id: 'a', was: { bib: '87', time: 100 }, station: 'Finish' },
  ]);

  // Leaving it out of a complete upload removes it just the same.
  store.applyPush('race', deviceA, push('Finish', []));
  assert.deepEqual(read(3).entries.map((entry) => [entry.kind, entry.was.bib]), [['gone', '5']]);
});

test('a mark without a number waits for its number; a number taken away again is reported', () => {
  const { store, wait, read, brief } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('m', '', 100, { source: 'manual', timing: 'manual' })]));
  wait(60);
  assert.deepEqual(read(0).entries, []);

  store.applyPush('race', deviceA, push('Finish', [crossing('m', '311', 100, { source: 'manual', timing: 'manual' })], { full: false }));
  wait(8);
  assert.deepEqual(brief(read(0).entries), [[1, 'read', '311', null]]);

  store.applyPush('race', deviceA, push('Finish', [crossing('m', '', 100, { source: 'manual', timing: 'manual' })], { full: false }));
  wait(8);
  assert.deepEqual(brief(read(1).entries), [[2, 'gone', null, '311']]);
  // And nothing more until it has a number again.
  wait(60);
  assert.deepEqual(read(2).entries, []);
  store.applyPush('race', deviceA, push('Finish', [crossing('m', '312', 100, { source: 'manual', timing: 'manual' })], { full: false }));
  wait(8);
  assert.deepEqual(brief(read(2).entries), [[3, 'read', '312', null]]);
});

test('results that settle together go out in finishing order, from every iPad', () => {
  const { store, wait, read } = feedSetup();
  store.applyPush('race', deviceA, push('Finish A', [crossing('a2', '20', 105), crossing('a1', '10', 101)]));
  store.applyPush('race', deviceB, push('Finish B', [crossing('b1', '10', 100.8), crossing('b2', '30', 103)]));
  wait(8);
  assert.deepEqual(read(0).entries.map((entry) => [entry.seq, entry.station, entry.bib, entry.time]), [
    [1, 'Finish B', '10', 100.8],
    [2, 'Finish A', '10', 101],
    [3, 'Finish B', '30', 103],
    [4, 'Finish A', '20', 105],
  ]);
});

test('a reader can ask for one iPad and still keeps its place in the whole feed', () => {
  const { store, wait, read } = feedSetup();
  store.applyPush('race', deviceA, push('Finish A', [crossing('a1', '10', 101)]));
  store.applyPush('race', deviceB, push('Finish B', [crossing('b1', '10', 100.8), crossing('b2', '30', 103)]));
  wait(8);

  const onlyA = read(0, { devices: [deviceA] });
  assert.deepEqual(onlyA.entries.map((entry) => entry.seq), [2]);
  assert.equal(onlyA.next, 3);
  assert.deepEqual(read(0, { stations: ['finish b'] }).entries.map((entry) => entry.seq), [1, 3]);
  assert.deepEqual(read(3, { devices: [deviceA] }).entries, []);

  // In pieces: the place returned is the last entry looked at.
  const piece = read(0, { limit: 2 });
  assert.deepEqual(piece.entries.map((entry) => entry.seq), [1, 2]);
  assert.equal(piece.next, 2);
  assert.deepEqual(read(piece.next, { limit: 2 }).entries.map((entry) => entry.seq), [3]);
});

test('an iPad sending everything again (the app was reopened) puts nothing into the feed twice', () => {
  const { store, wait, read } = feedSetup();
  const everything = push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]);
  store.applyPush('race', deviceA, everything);
  wait(10);
  assert.equal(read(0).next, 2);

  store.applyPush('race', deviceA, everything);
  wait(10);
  assert.deepEqual(read(2).entries, []);

  // Renaming the station is not a new result either.
  store.applyPush('race', deviceA, { ...everything, station: 'Finish line' });
  wait(10);
  assert.deepEqual(read(2).entries, []);
  assert.deepEqual(read(0).entries.map((entry) => entry.station), ['Finish line', 'Finish line']);
});

test('a reader that last read another feed, or is ahead of this one, starts from the beginning', () => {
  const { store, wait } = feedSetup();
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]));
  wait(10);
  const { feedID } = store.feed('race');
  assert.equal(typeof feedID, 'string');
  assert.deepEqual(store.feed('race', { after: 2, feedID }).entries, []);

  assert.equal(store.feed('race', { after: 2, feedID: 'some-other-feed' }).entries.length, 2);
  assert.equal(store.feed('race', { after: 2 }).entries.length, 2);
  assert.equal(store.feed('race', { after: 7, feedID }).entries.length, 2);
  assert.equal(store.feed('race', { after: -1, feedID }).entries.length, 2);
  assert.equal(store.feed('nothing-here'), null);

  // An event that is removed and comes back is a new feed.
  store.deleteEvent('race');
  store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100)]));
  wait(10);
  const again = store.feed('race', { after: 2, feedID });
  assert.notEqual(again.feedID, feedID);
  assert.deepEqual(again.entries.map((entry) => entry.seq), [1]);
});

test('the feed survives a restart of the hub', () => {
  const dataDir = temporaryDirectory();
  const first = feedSetup({ dataDir });
  first.store.applyPush('race', deviceA, push('Finish', [crossing('a', '87', 100), crossing('b', '5', 101)]));
  first.wait(10);
  const before = first.store.feed('race');
  assert.equal(before.next, 2);
  first.store.applyPush('race', deviceA, push('Finish', [crossing('a', '78', 100)], { full: false }));
  first.store.applyPush('race', deviceA, push('Finish', [], { full: false, deleted: ['b'] }));
  first.store.flush();

  const second = feedSetup({ dataDir });
  second.clock.now = first.clock.now;
  const after = second.store.feed('race', { after: 2, feedID: before.feedID });
  assert.equal(after.feedID, before.feedID);
  // Removed before the restart; corrected, but not yet left alone for long enough.
  assert.deepEqual(after.entries.map((entry) => [entry.seq, entry.kind]), [[3, 'gone']]);
  second.wait(8);
  assert.deepEqual(second.store.feed('race', { after: 3, feedID: before.feedID }).entries, [
    { seq: 4, kind: 'read', device: deviceA, id: 'a', bib: '78', time: 100, was: { bib: '87', time: 100 }, station: 'Finish' },
  ]);
  // What went out before the restart is still there for a reader that starts over.
  assert.deepEqual(second.store.feed('race').entries.map((entry) => entry.seq), [1, 2, 3, 4]);
});

test('a very long feed drops its oldest entries and keeps counting', () => {
  const { store, wait, read } = feedSetup();
  const original = limits.feedEntries;
  limits.feedEntries = 6;
  try {
    for (let round = 0; round < 4; round += 1) {
      store.applyPush('race', deviceA, push('Finish', [crossing(`a${round}`, String(round + 1), 100 + round), crossing(`b${round}`, String(round + 50), 100.5 + round)], { full: false }));
      wait(8);
      read(0);
    }
    const all = read(0);
    assert.deepEqual(all.entries.map((entry) => entry.seq), [4, 5, 6, 7, 8]);
    assert.equal(all.next, 8);
    assert.deepEqual(read(6).entries.map((entry) => entry.seq), [7, 8]);
  } finally {
    limits.feedEntries = original;
  }
});

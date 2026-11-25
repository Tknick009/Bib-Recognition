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

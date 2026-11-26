// The capture page's clock and its uploads to the hub.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventCode, hasChanges, isCheckIn, isValidCode, normalizedCode, planPush, stateAfter, wireCrossing } from '../public/capture/lib/planner.js';
import { bestOf, measure, RaceClock } from '../public/capture/lib/timesync.js';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// ---- The clock ----

test('one question to the hub gives the difference between the clocks and how far off it could be', () => {
  // The local clock is 5 000 ms behind the hub. 40 ms there, 2 ms at the hub, 60 ms back.
  const sample = measure({ sent: 1000, serverReceived: 6040, serverSent: 6042, received: 1102 });
  close(sample.delay, 100);
  // The way there and the way back took different times, which cannot be
  // seen from here: the answer is off by half the difference, within delay / 2.
  close(sample.offset, 4990);
  assert.ok(Math.abs(sample.offset - 5000) <= sample.delay / 2);

  // With both ways alike the answer is exact.
  close(measure({ sent: 1000, serverReceived: 6050, serverSent: 6050, received: 1100 }).offset, 5000);
});

test('the quickest answer is the one to trust', () => {
  const samples = [{ offset: 5010, delay: 180 }, { offset: 5001, delay: 42 }, { offset: 4950, delay: 300 }, { offset: 1, delay: -5 }, { offset: NaN, delay: 1 }];
  assert.deepEqual(bestOf(samples), { offset: 5001, delay: 42 });
  assert.equal(bestOf([]), null);
  assert.equal(bestOf([{ offset: 3, delay: -1 }]), null);
});

test('the clock gives hub time once it has a fix, and says how sure it is', () => {
  let local = 10_000;
  const clock = new RaceClock(() => local);
  assert.equal(clock.isSynced, false);
  // Without a fix: the device's own idea of the time, marked as such.
  assert.deepEqual(clock.at(10_000, 1_800_000_000_000), { time: 1_800_000_010, source: 'device', error: null });

  assert.equal(clock.adopt({ offset: 1_800_000_000_000, delay: 40 }, 5), true);
  assert.equal(clock.isSynced, true);
  const now = clock.at();
  assert.equal(now.source, 'ntp');
  close(now.time, 1_800_000_010);
  close(now.error, 0.025);

  // An hour later the fix counts for less: 72 ms more.
  local += 3_600_000;
  close(clock.at().error, 0.025 + 0.072, 1e-9);
  close(clock.at(local - 1000).time, 1_800_003_609);
});

test('a rougher measurement does not replace a better one, unless that one is old', () => {
  let local = 0;
  const clock = new RaceClock(() => local);
  clock.adopt({ offset: 500, delay: 20 });
  local += 60_000;
  assert.equal(clock.adopt({ offset: 530, delay: 200 }), false);
  assert.equal(clock.fix.offset, 500);
  assert.equal(clock.adopt({ offset: 501, delay: 18 }), true);
  assert.equal(clock.fix.offset, 501);

  local += 16 * 60_000;
  assert.equal(clock.adopt({ offset: 540, delay: 200 }), true);
  assert.equal(clock.fix.offset, 540);

  clock.forget();
  assert.equal(clock.isSynced, false);
});

// ---- Uploads ----

const base = 1_800_000_000;
const crossing = (id, bib, seconds, extra = {}) => ({
  id, bib, time: base + seconds, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.0123456, confidence: 0.8999999761581421,
  sightings: 4, firstSeen: base + seconds - 1, lastSeen: base + seconds + 1, detectedBib: null, note: '', ...extra,
});
const race = (crossings, extra = {}) => ({ name: 'Spring 5K', startTime: base, crossings, ...extra });
const plan = (current, known) => planPush(current, 'Finish', 'UTC', known);
// What the hub answers when it has taken an upload in.
const accept = (push, known, store = 'store-1', alreadyThere = []) => {
  const held = new Map([...alreadyThere.map((id) => [id, { id }]), ...(known?.crossings ?? [])]);
  for (const item of push.crossings) held.set(item.id, item);
  for (const id of push.deleted) held.delete(id);
  return stateAfter(push, { store, count: held.size + (known?.extra ?? 0) }, known);
};

test('a result is sent with no more digits than mean anything, and without what the hub has no use for', () => {
  const wire = wireCrossing(crossing('A1', '1041', 1512.3474));
  assert.deepEqual(wire, { id: 'A1', bib: '1041', time: base + 1512.347, timing: 'line', source: 'camera', clock: 'ntp', note: '', clockError: 0.0123, confidence: 0.9 });
  assert.ok(JSON.stringify(wire).length < 190);
  // What is not known is left out, not sent as null.
  const mark = wireCrossing(crossing('M1', '', 10, { source: 'manual', timing: 'manual', clockError: null, confidence: null }));
  assert.equal(JSON.stringify(mark).includes('null'), false);
  assert.equal('confidence' in mark, false);
});

test('everything is sent when it is not known what the hub holds, and only changes after that', () => {
  const a = crossing('A', '1', 10);
  const b = crossing('B', '2', 20);
  const c = crossing('C', '3', 30);
  let current = race([a, b, c]);
  const first = plan(current, null);
  // Never "full": to the hub that word means "drop whatever is not in here".
  assert.equal(first.full, false);
  assert.deepEqual(first.deleted, []);
  assert.deepEqual(first.crossings.map((item) => item.bib), ['1', '2', '3']);
  assert.equal(first.station, 'Finish');
  assert.equal(first.raceName, 'Spring 5K');
  assert.equal(first.startTime, base);
  assert.equal(isCheckIn(first), false);
  assert.equal(hasChanges(first, null), true);

  const known = accept(first, null);
  assert.equal(known.crossings.size, 3);
  assert.equal(known.extra, 0);

  // Nothing has changed: nothing to send but a sign of life.
  const idle = plan(current, known);
  assert.equal(isCheckIn(idle), true);
  assert.equal(hasChanges(idle, known), false);
  assert.ok(JSON.stringify(idle).length < 160);

  // One result corrected, one deleted, one added.
  current = race([{ ...a, bib: '11' }, c, crossing('D', '4', 40)]);
  const changes = plan(current, known);
  assert.equal(changes.full, false);
  assert.deepEqual(changes.crossings.map((item) => item.bib), ['11', '4']);
  assert.deepEqual(changes.deleted, ['B']);
  assert.equal(hasChanges(changes, known), true);

  const after = accept(changes, known);
  assert.deepEqual(new Set([...after.crossings.values()].map((item) => item.bib)), new Set(['11', '3', '4']));
  assert.equal(isCheckIn(plan(current, after)), true);
});

test('a changed start time or station name is a change', () => {
  const current = race([crossing('A', '1', 10)]);
  const known = accept(plan(current, null), null);
  const moved = plan({ ...current, startTime: base + 5 }, known);
  assert.equal(isCheckIn(moved), true);
  assert.equal(hasChanges(moved, known), true);
  assert.equal(hasChanges(planPush(current, 'Finish B', 'UTC', known), known), true);
  // A race with no start time yet sends none.
  const unstarted = plan({ ...current, startTime: null }, null);
  assert.equal('startTime' in unstarted, false);
  assert.equal(hasChanges(plan({ ...current, startTime: null }, known), known), true);
});

test('an answer that does not fit means everything is sent again', () => {
  const current = race([crossing('A', '1', 10), crossing('B', '2', 20)]);
  const everything = plan(current, null);
  // The hub holds fewer results than it was just sent: it has refused some.
  assert.equal(stateAfter(everything, { store: 'store-1', count: 1 }, null), null);

  const known = accept(everything, null);
  const more = race([...current.crossings, crossing('C', '3', 30)]);
  const partial = plan(more, known);
  assert.deepEqual(partial.crossings.map((item) => item.id), ['C']);
  // The hub has lost its data since: it answers as a different store.
  assert.equal(stateAfter(partial, { store: 'store-2', count: 1 }, known), null);
  // Or it counts differently from what it should hold by now.
  assert.equal(stateAfter(partial, { store: 'store-1', count: 2 }, known), null);
  // Everything, sent to the new store, is fine.
  assert.equal(accept(plan(more, null), null, 'store-2').store, 'store-2');
});

test('what the hub holds beyond what this iPad has is left alone', () => {
  // The page was loaded again with an older list than the hub has (it could
  // not save the last results), or the race was cleared off the iPad and
  // joined again: the hub has results from this iPad that the iPad has not.
  const current = race([crossing('A', '1', 10)]);
  const everything = plan(current, null);
  assert.deepEqual([everything.full, everything.deleted], [false, []], 'nothing in the upload takes them away');
  const known = accept(everything, null, 'store-1', ['OLD-1', 'OLD-2']);
  assert.equal(known.extra, 2);
  assert.equal(known.crossings.size, 1);

  // From then on only changes are sent, and the count is checked with the two on top.
  const more = race([...current.crossings, crossing('B', '2', 20)]);
  const next = plan(more, known);
  assert.deepEqual([next.crossings.map((item) => item.id), next.deleted], [['B'], []]);
  const after = stateAfter(next, { store: 'store-1', count: 4 }, known);
  assert.deepEqual([after.crossings.size, after.extra], [2, 2]);
  assert.equal(stateAfter(next, { store: 'store-1', count: 2 }, known), null, 'a count that fits neither is a reason to send everything');
});

test('a result deleted on the iPad is taken off the hub, also after the page has been loaded again', () => {
  const a = crossing('A', '1', 10);
  const b = crossing('B', '2', 20);
  // Deleted while it was not known what the hub holds (no connection, then a reload):
  // the iPad has kept a note of it.
  const afterReload = race([a], { deleted: ['B'] });
  const first = plan(afterReload, null);
  assert.deepEqual([first.crossings.map((item) => item.id), first.deleted], [['A'], ['B']]);

  // Deleted while it is known what the hub holds: no note is needed, and one that is there does no harm.
  const known = accept(plan(race([a, b]), null), null);
  assert.deepEqual(plan(race([a]), known).deleted, ['B']);
  assert.deepEqual(plan(race([a], { deleted: ['B', 'B', 'GONE-LONG-AGO'] }), known).deleted, ['B', 'GONE-LONG-AGO']);
  // A result that is back (deleted and recorded again under the same identifier) is not deleted.
  assert.deepEqual(plan(race([a, b], { deleted: ['B'] }), known).deleted, []);
});

test('the event code comes from the race name and the day', () => {
  const newYear = 1_609_459_200;
  assert.equal(eventCode('Spring 5K / Fun Run', newYear, 'UTC'), 'spring-5k-fun-run-20210101');
  assert.equal(eventCode('  ', newYear, 'UTC'), 'race-20210101');
  // The date is the local one.
  assert.equal(eventCode('Dash', newYear, 'America/New_York'), 'dash-20201231');
  const long = eventCode('marathon '.repeat(20), newYear, 'UTC');
  assert.ok(long.length <= 50);
  assert.equal(isValidCode(long), true);

  assert.equal(isValidCode('spring-5k-20261125'), true);
  assert.equal(isValidCode('abc'), true);
  for (const bad of ['ab', 'Spring', '-spring', 'spring-', 'spring 5k', 'a'.repeat(51), null]) assert.equal(isValidCode(bad), false, String(bad));
  assert.equal(normalizedCode('  Spring 5K — Finish  '), 'spring-5k-finish');
  assert.equal(normalizedCode('!!!'), '');
});

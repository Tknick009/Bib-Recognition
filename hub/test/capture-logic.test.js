// The capture page's timing logic, which runs in the browser on the iPads.
// These are the same cases the iPad app's own tests cover.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bibDetections, bibFrom, canonicalBib, defaultRules, parseRoster } from '../public/capture/lib/bibfilter.js';
import { clampBox, fitMapping, lineIsUsable, sideOfLine, standardLine } from '../public/capture/lib/geometry.js';
import { CrossingLedger, defaultRepeatRule, duplicateBibs, inFinishingOrder, manualCrossing, newID } from '../public/capture/lib/ledger.js';
import { BibTracker, defaultTrackerConfig, isNear, isSimilar } from '../public/capture/lib/tracker.js';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// ---- Which texts are bib numbers ----

test('plain numbers are bib numbers', () => {
  const rules = defaultRules();
  assert.equal(bibFrom('1234', rules), '1234');
  assert.equal(bibFrom(' 57 ', rules), '57');
  assert.equal(bibFrom('#308', rules), '308');
  assert.equal(bibFrom('|416|', rules), '416');
  assert.equal(bibFrom('0042', rules), '42');
});

test('text that is not a bib number is turned down', () => {
  const rules = defaultRules();
  for (const text of ['', 'RUN', '5K', '10K', '12:34', '1,234', 'A123', '0', '000', '123456', '3.5', '12 34']) {
    assert.equal(bibFrom(text, rules), null, `"${text}" should not be a bib`);
  }
});

test('one look-alike letter is read as its digit', () => {
  const rules = defaultRules();
  assert.equal(bibFrom('1O4', rules), '104');
  assert.equal(bibFrom('I23', rules), '123');
  assert.equal(bibFrom('25S', rules), '255');
  // Too little of it is really a number.
  assert.equal(bibFrom('SOS', rules), null);
  assert.equal(bibFrom('O2', rules), null);
  assert.equal(bibFrom('l0S', rules), null);

  rules.fixLookalikes = false;
  assert.equal(bibFrom('1O4', rules), null);
  assert.equal(bibFrom('104', rules), '104');
});

test('the number of digits and the range of numbers can be limited', () => {
  let rules = { ...defaultRules(), minDigits: 3, maxDigits: 3 };
  assert.equal(bibFrom('42', rules), null);
  assert.equal(bibFrom('1234', rules), null);
  assert.equal(bibFrom('123', rules), '123');

  rules = { ...defaultRules(), minNumber: 100, maxNumber: 499 };
  assert.equal(bibFrom('99', rules), null);
  assert.equal(bibFrom('100', rules), '100');
  assert.equal(bibFrom('499', rules), '499');
  assert.equal(bibFrom('500', rules), null);
});

test('texts are sifted by sureness, size, the ignore list and the start list', () => {
  const rules = { ...defaultRules(), ignored: ['2026'] };
  const candidate = (text, confidence = 1, height = 0.05) => ({ text, confidence, box: { x: 0.4, y: 0.4, width: 0.1, height } });
  const candidates = [candidate('1234'), candidate('77', 0.3), candidate('88', 1, 0.01), candidate('2026'), candidate('RUN'), candidate('999')];

  const open = bibDetections(candidates, rules, null);
  assert.deepEqual(open.map((item) => item.bib), ['1234', '999']);
  assert.deepEqual(open[0], { bib: '1234', confidence: 1, box: { x: 0.4, y: 0.4, width: 0.1, height: 0.05 } });

  const restricted = bibDetections(candidates, rules, new Set(['1234', '55']));
  assert.deepEqual(restricted.map((item) => item.bib), ['1234']);
});

test('a typed bib number is put into its standard spelling', () => {
  assert.equal(canonicalBib('#007'), '7');
  assert.equal(canonicalBib(' 12 '), '12');
  assert.equal(canonicalBib('12a'), null);
  assert.equal(canonicalBib(''), null);
  assert.equal(canonicalBib('0'), null);
});

test('a start list is read from whatever a spreadsheet makes of it', () => {
  const roster = parseRoster([
    'Bib,Name', '101,Jane Doe', '102;John;Smith', '103\tAna\tLima', '104 Bob Stone', '#105', '101,Duplicate', '', 'not a runner', '007,"James Bond"',
  ].join('\n'));
  assert.deepEqual(roster.map((entry) => entry.bib), ['101', '102', '103', '104', '105', '7']);
  assert.deepEqual(roster.map((entry) => entry.name), ['Jane Doe', 'John Smith', 'Ana Lima', 'Bob Stone', '', 'James Bond']);

  assert.deepEqual(parseRoster('1,Ana\r\n2,Ben\r\n'), [{ bib: '1', name: 'Ana' }, { bib: '2', name: 'Ben' }]);
  // Files saved as "CSV UTF-8" start with a byte order mark, which would otherwise hide the first runner's number.
  assert.deepEqual(parseRoster('﻿101,Jane Doe\r\n102,John Smith\r\n'), [{ bib: '101', name: 'Jane Doe' }, { bib: '102', name: 'John Smith' }]);
});

// ---- Places in the picture ----

test('the finish line has a finished side', () => {
  const level = { a: { x: 0, y: 0.6 }, b: { x: 1, y: 0.6 }, reversed: false };
  assert.ok(sideOfLine(level, { x: 0.5, y: 0.3 }) < 0);
  assert.ok(sideOfLine(level, { x: 0.5, y: 0.9 }) > 0);
  close(sideOfLine(level, { x: 0.2, y: 0.6 }), 0);
  assert.ok(sideOfLine({ ...level, reversed: true }, { x: 0.5, y: 0.3 }) > 0);
  // Twice as far from the line is twice the value.
  close(sideOfLine(level, { x: 0.5, y: 0.8 }), 2 * sideOfLine(level, { x: 0.5, y: 0.7 }));
  assert.equal(lineIsUsable(standardLine), true);
  assert.equal(lineIsUsable({ a: { x: 0.5, y: 0.5 }, b: { x: 0.505, y: 0.5 }, reversed: false }), false);
});

test('boxes are kept inside the picture, and the picture is fitted into a view', () => {
  assert.deepEqual(clampBox({ x: -0.25, y: 0.5, width: 0.5, height: 0.75 }), { x: 0, y: 0.5, width: 0.25, height: 0.5 });
  // A 1920 x 1080 picture in a 1000 x 1000 view: bars above and below.
  const mapping = fitMapping(1920, 1080, 1000, 1000);
  close(mapping.viewX(0), 0);
  close(mapping.viewX(1), 1000);
  close(mapping.viewY(0), (1000 - 562.5) / 2);
  const back = mapping.toPicture(mapping.viewX(0.25), mapping.viewY(0.75));
  close(back.x, 0.25);
  close(back.y, 0.75);
});

// ---- Following bibs ----

// A level line 60 % of the way down the picture; bibs approach from above.
const line = { a: { x: 0, y: 0.6 }, b: { x: 1, y: 0.6 }, reversed: false };
const detection = (bib, y, x = 0.5, confidence = 1) => ({ bib, confidence, box: { x: x - 0.05, y: y - 0.02, width: 0.1, height: 0.04 } });
const tracker = (mode = 'line', reversed = false) => new BibTracker({ ...defaultTrackerConfig(), mode, line: { ...line, reversed } });

test('the time is worked out for the moment the bib crosses the finish line', () => {
  const following = tracker();
  const events = [];
  // The bib moves down the picture at one picture height a second and is
  // read every 0.1 s. It reaches the line (y = 0.6) at 10.27 s.
  for (let step = 0; step <= 5; step += 1) {
    events.push(...following.process(10 + step * 0.1, [detection('101', 0.33 + step * 0.1)]).events);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].bib, '101');
  assert.equal(events[0].timing, 'line');
  assert.equal(events[0].isNew, true);
  assert.equal(events[0].ended, false);
  close(events[0].time, 10.27);
  close(events[0].firstSeen, 10);

  // Once the bib has been gone for a while the track is closed.
  const later = following.process(13, []).events;
  assert.equal(later.length, 1);
  assert.equal(later[0].ended, true);
  assert.equal(later[0].isNew, false);
  assert.equal(later[0].sightings, 6);
  close(later[0].time, 10.27);
  assert.equal(following.activeTrackCount, 0);
});

test('a bib lost before the line gets its last sighting', () => {
  const following = tracker();
  assert.deepEqual(following.process(1.0, [detection('7', 0.30)]).events, []);
  assert.deepEqual(following.process(1.1, [detection('7', 0.40)]).events, []);
  assert.deepEqual(following.process(1.2, [detection('7', 0.50)]).events, []);
  // Still within the time allowed: nothing yet.
  assert.deepEqual(following.process(3.0, []).events, []);

  const events = following.process(3.5, []).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].timing, 'estimated');
  close(events[0].time, 1.2);
  assert.equal(events[0].isNew, true);
  assert.equal(events[0].ended, true);
});

test('a bib hidden for a moment is still timed at the line', () => {
  const following = tracker();
  // Read twice on the way in, hidden behind another runner for 1.5 s, then read again past the line.
  assert.deepEqual(following.process(1.0, [detection('64', 0.30)]).events, []);
  assert.deepEqual(following.process(1.1, [detection('64', 0.35)]).events, []);
  for (let step = 1; step <= 14; step += 1) {
    assert.deepEqual(following.process(1.1 + step * 0.1, []).events, []);
  }
  const events = following.process(2.6, [detection('64', 0.85)]).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].timing, 'line');
  // Half-way between the two sightings either side of the line.
  close(events[0].time, 1.85);
  assert.equal(following.activeTrackCount, 1);
});

test('a bib first read past the line gets its first sighting', () => {
  const following = tracker();
  assert.deepEqual(following.process(5.0, [detection('88', 0.70)]).events, []);
  const events = following.process(5.1, [detection('88', 0.75)]).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].timing, 'estimated');
  close(events[0].time, 5.0);
  assert.equal(events[0].isNew, true);
  assert.equal(events[0].ended, false);
});

test('a flipped line counts the other direction', () => {
  const following = tracker('line', true);
  const events = [];
  // Moving up the picture: 0.80, 0.70, 0.60, 0.50 ... crosses y = 0.6 at 2.2 s.
  for (let step = 0; step <= 4; step += 1) {
    events.push(...following.process(2 + step * 0.1, [detection('5', 0.8 - step * 0.1)]).events);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].timing, 'line');
  close(events[0].time, 2.2);
});

test('a number read only once is not reported', () => {
  const following = tracker('firstSeen');
  assert.deepEqual(following.process(1, [detection('404', 0.5)]).events, []);
  assert.deepEqual(following.process(5, []).events, []);
  assert.equal(following.activeTrackCount, 0);
  assert.deepEqual(following.finish(), []);
});

test('times can be taken at the first or the last sighting instead', () => {
  const first = tracker('firstSeen');
  assert.deepEqual(first.process(2.0, [detection('9', 0.3)]).events, []);
  const firstEvents = first.process(2.1, [detection('9', 0.3)]).events;
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].timing, 'firstSeen');
  close(firstEvents[0].time, 2.0);

  const last = tracker('lastSeen');
  for (let step = 0; step <= 2; step += 1) {
    assert.deepEqual(last.process(2 + step * 0.1, [detection('9', 0.3)]).events, []);
  }
  const lastEvents = last.finish();
  assert.equal(lastEvents.length, 1);
  assert.equal(lastEvents[0].timing, 'lastSeen');
  close(lastEvents[0].time, 2.2);
  assert.equal(lastEvents[0].isNew, true);
  assert.equal(lastEvents[0].ended, true);
  assert.equal(last.activeTrackCount, 0);
});

test('a number read with a digit missing does not become a second bib', () => {
  const following = tracker('firstSeen');
  const events = [];
  // An arm hides the first digit in two of the pictures.
  ['1234', '1234', '234', '234', '1234', '1234'].forEach((bib, step) => {
    events.push(...following.process(step * 0.1, [detection(bib, 0.3 + step * 0.01)]).events);
  });
  assert.equal(following.activeTrackCount, 1);
  events.push(...following.finish());
  assert.equal(new Set(events.map((event) => event.trackID)).size, 1);
  assert.deepEqual(events.map((event) => event.bib), ['1234', '1234']);
  assert.equal(events.at(-1).sightings, 6);
});

test('the number is corrected when later readings disagree', () => {
  const following = tracker('firstSeen');
  const events = [];
  ['123', '123', '1234', '1234', '1234'].forEach((bib, step) => {
    events.push(...following.process(step * 0.1, [detection(bib, 0.3)]).events);
  });
  assert.deepEqual(events.map((event) => event.bib), ['123', '1234']);
  assert.deepEqual(events.map((event) => event.isNew), [true, false]);
  assert.equal(new Set(events.map((event) => event.trackID)).size, 1);
  // The time taken at the first report does not move.
  close(events.at(-1).time, 0);
});

test('bibs side by side are followed separately', () => {
  const following = tracker();
  const events = [];
  for (let step = 0; step <= 4; step += 1) {
    const y = 0.45 + step * 0.1;
    events.push(...following.process(step * 0.1, [detection('12', y, 0.3), detection('13', y - 0.02, 0.7)]).events);
  }
  assert.deepEqual(new Set(events.map((event) => event.bib)), new Set(['12', '13']));
  assert.equal(new Set(events.map((event) => event.trackID)).size, 2);
  assert.ok(events.every((event) => event.timing === 'line'));
});

test('different numbers in the same place are different bibs', () => {
  const following = tracker();
  following.process(0.0, [detection('45', 0.3)]);
  following.process(0.1, [detection('892', 0.3)]);
  assert.equal(following.activeTrackCount, 2);
});

test('what is drawn on a bib follows its state', () => {
  const following = tracker();
  assert.deepEqual(following.process(0.0, [detection('31', 0.40)]).overlays.map((item) => item.state), ['pending']);
  assert.deepEqual(following.process(0.1, [detection('31', 0.50)]).overlays.map((item) => item.state), ['tracking']);
  const crossed = following.process(0.2, [detection('31', 0.65)]);
  assert.deepEqual(crossed.overlays.map((item) => item.state), ['timed']);
  assert.equal(crossed.overlays[0].bib, '31');
  assert.equal(crossed.events.length, 1);
  assert.deepEqual(following.process(0.3, []).overlays, []);
});

test('which numbers could be misreadings of one another', () => {
  assert.equal(isSimilar('1234', '1234'), true);
  assert.equal(isSimilar('1234', '234'), true);
  assert.equal(isSimilar('123', '1234'), true);
  assert.equal(isSimilar('1234', '134'), true);
  assert.equal(isSimilar('1234', '1284'), true);
  assert.equal(isSimilar('1234', '1288'), false);
  assert.equal(isSimilar('45', '892'), false);
  assert.equal(isSimilar('7', '8'), false);
});

// A browser looks at the picture a few times a second, not ten or more: a
// runner moves well over a bib's width between two looks.
test('a fast runner looked at only three times a second is still one bib, timed at the line', () => {
  const following = new BibTracker({ ...defaultTrackerConfig(), line, mergeWindow: 1.2 });
  const events = [];
  // 0.33 s apart, moving 0.12 of the picture each time; a digit is missing in one of the readings.
  ['2843', '2843', '284', '2843', '2843'].forEach((bib, step) => {
    events.push(...following.process(step / 3, [detection(bib, 0.3 + step * 0.12)]).events);
  });
  events.push(...following.finish());
  assert.equal(new Set(events.map((event) => event.trackID)).size, 1);
  assert.equal(events[0].bib, '2843');
  assert.equal(events[0].timing, 'line');
  // Past the line (0.6) between the looks at y = 0.54 (0.667 s) and y = 0.66 (1 s): half-way.
  close(events[0].time, 2 / 3 + (1 / 3) * 0.5, 1e-6);
});

test('two runners with nearly the same number, close together, stay two bibs', () => {
  const following = new BibTracker({ ...defaultTrackerConfig(), line, mergeWindow: 1.2 });
  const events = [];
  // 123 leads; 124 follows half a second behind on the same path, a body length back.
  for (let step = 0; step <= 6; step += 1) {
    const found = [detection('123', 0.20 + step * 0.1)];
    if (step >= 1) found.push(detection('124', 0.20 + (step - 1.5) * 0.1, 0.55));
    events.push(...following.process(step / 3, found).events);
  }
  events.push(...following.finish());
  assert.deepEqual(new Set(events.map((event) => event.bib)), new Set(['123', '124']));
  assert.equal(new Set(events.map((event) => event.trackID)).size, 2);
});

test('how near two boxes must be to be the same bib', () => {
  const box = (x, y, height = 0.04) => ({ x: x - 0.05, y: y - height / 2, width: 0.1, height });
  assert.equal(isNear(box(0.5, 0.5), box(0.55, 0.52)), true);
  assert.equal(isNear(box(0.5, 0.5), box(0.7, 0.5)), false);
  assert.equal(isNear(box(0.5, 0.5), box(0.5, 0.555)), false);
  assert.equal(isNear(box(0.5, 0.5), box(0.5, 0.555), 1.5), true);
  // A bib does not double in size from one look to the next.
  assert.equal(isNear(box(0.5, 0.5), box(0.5, 0.5, 0.1)), false);
});

// ---- From reports to results ----

const base = 1_800_000_000;
const report = (trackID, bib, seconds, { ended = false, sightings = 3 } = {}) => ({
  trackID, bib, time: base + seconds, timing: 'line', clock: { source: 'ntp', error: 0.01 },
  firstSeen: base + seconds - 1, lastSeen: base + seconds + 1, sightings, confidence: 1, ended,
});

test('each bib is recorded once unless repeats are allowed', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();

  const first = ledger.apply(report(1, '101', 0, { ended: true }), crossings, rule);
  assert.equal(first.change, 'added');
  assert.deepEqual(crossings.map((crossing) => crossing.id), [first.id]);
  assert.equal(crossings[0].source, 'camera');
  assert.equal(crossings[0].timing, 'line');
  assert.equal(crossings[0].clock, 'ntp');
  assert.equal(crossings[0].clockError, 0.01);

  // The same runner wanders back into view minutes later.
  assert.deepEqual(ledger.apply(report(2, '101', 300), crossings, rule), { change: 'none' });
  assert.equal(ledger.apply(report(3, '102', 301), crossings, rule).change, 'added');
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['101', '102']);
});

test('laps need a shortest time between them', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = { allowRepeats: true, minInterval: 30 };
  ledger.apply(report(1, '101', 0, { ended: true }), crossings, rule);
  assert.deepEqual(ledger.apply(report(2, '101', 10, { ended: true }), crossings, rule), { change: 'none' });
  ledger.apply(report(3, '101', 45, { ended: true }), crossings, rule);
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['101', '101']);
  assert.deepEqual(crossings.map((crossing) => crossing.time - base), [0, 45]);
});

test('a corrected number changes the same result', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();
  ledger.apply(report(1, '123', 5), crossings, rule);
  const id = crossings[0].id;
  assert.deepEqual(ledger.apply(report(1, '1234', 5, { sightings: 6 }), crossings, rule), { change: 'updated', id });
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].bib, '1234');
  assert.equal(crossings[0].sightings, 6);
  // Nothing changed: nothing to report.
  assert.deepEqual(ledger.apply(report(1, '1234', 5, { sightings: 6 }), crossings, rule), { change: 'none' });
});

test('a misread of a bib that is recorded already is withdrawn', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();
  ledger.apply(report(1, '1234', 0, { ended: true }), crossings, rule);
  // The finisher is seen again, at first with a digit hidden.
  ledger.apply(report(2, '123', 20), crossings, rule);
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['1234', '123']);
  const misread = crossings[1].id;
  assert.deepEqual(ledger.apply(report(2, '1234', 20), crossings, rule), { change: 'removed', id: misread });
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['1234']);
  assert.deepEqual(ledger.apply(report(2, '1234', 20, { ended: true }), crossings, rule), { change: 'none' });
  assert.equal(crossings.length, 1);
});

test('a track that was held back is recorded once its number changes', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();
  ledger.apply(report(1, '101', 0, { ended: true }), crossings, rule);
  assert.deepEqual(ledger.apply(report(2, '101', 50), crossings, rule), { change: 'none' });
  ledger.apply(report(2, '107', 50), crossings, rule);
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['101', '107']);
});

test('a number corrected by hand is not overwritten by the camera', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();
  ledger.apply(report(1, '123', 5), crossings, rule);
  crossings[0] = { ...crossings[0], detectedBib: crossings[0].bib, bib: '128' };
  ledger.apply(report(1, '1234', 5, { ended: true, sightings: 9 }), crossings, rule);
  assert.equal(crossings[0].bib, '128');
  assert.equal(crossings[0].detectedBib, '123');
  assert.equal(crossings[0].sightings, 9);
});

test('a deleted result stays deleted while the bib is in view', () => {
  const ledger = new CrossingLedger();
  const crossings = [];
  const rule = defaultRepeatRule();
  ledger.apply(report(1, '55', 0), crossings, rule);
  crossings.length = 0;
  assert.deepEqual(ledger.apply(report(1, '55', 0), crossings, rule), { change: 'none' });
  assert.deepEqual(ledger.apply(report(1, '55', 0, { ended: true }), crossings, rule), { change: 'none' });
  assert.equal(crossings.length, 0);
  // A fresh sighting after it left the picture is recorded again.
  ledger.apply(report(2, '55', 60), crossings, rule);
  assert.deepEqual(crossings.map((crossing) => crossing.bib), ['55']);
});

test('results sort by time, duplicates are found, marks have no number', () => {
  const mark = (bib, seconds) => manualCrossing(bib, base + seconds, { source: 'ntp', error: 0.01 });
  assert.deepEqual(inFinishingOrder([mark('3', 30), mark('1', 10), mark('2', 20)]).map((crossing) => crossing.bib), ['1', '2', '3']);
  assert.deepEqual(duplicateBibs([mark('7', 1), mark('8', 2), mark('7', 3), mark('', 4), mark('', 5)]), new Set(['7']));
  const made = mark('', 12);
  assert.equal(made.source, 'manual');
  assert.equal(made.timing, 'manual');
  assert.equal(made.clock, 'ntp');
  assert.match(made.id, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.notEqual(newID(), newID());
});

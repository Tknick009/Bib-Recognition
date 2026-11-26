import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  elapsed, escapeCSV, fileSlug, isoUTC, isTimeZone, localDate, runScoreField, runScoreLine, safeText, timeOfDay, toCSV,
} from '../lib/format.js';

const newYear2021 = 1_609_459_200; // 2021-01-01T00:00:00Z

test('time of day in a time zone, to the millisecond', () => {
  assert.equal(timeOfDay(newYear2021 + 0.123, 'UTC'), '00:00:00.123');
  assert.equal(timeOfDay(newYear2021 + 0.123, 'America/New_York'), '19:00:00.123');
  assert.equal(timeOfDay(newYear2021 + 3600 * 13 + 61.5, 'UTC'), '13:01:01.500');
  // Rounds to the nearest millisecond, carrying into the seconds.
  assert.equal(timeOfDay(newYear2021 + 59.9996, 'UTC'), '00:01:00.000');
});

test('dates and UTC timestamps', () => {
  assert.equal(localDate(newYear2021, 'UTC'), '2021-01-01');
  assert.equal(localDate(newYear2021, 'America/New_York'), '2020-12-31');
  assert.equal(isoUTC(newYear2021 + 0.123), '2021-01-01T00:00:00.123Z');
});

test('elapsed times', () => {
  assert.equal(elapsed(newYear2021, newYear2021), '0:00:00.000');
  assert.equal(elapsed(newYear2021, newYear2021 + 5025.678), '1:23:45.678');
  assert.equal(elapsed(newYear2021, newYear2021 - 1.5), '-0:00:01.500');
  assert.equal(elapsed(newYear2021, newYear2021 + 108_000), '30:00:00.000');
});

test('time zone names are checked', () => {
  assert.equal(isTimeZone('Europe/London'), true);
  assert.equal(isTimeZone('Mars/Olympus'), false);
  assert.equal(isTimeZone(''), false);
  assert.equal(isTimeZone(null), false);
});

test('CSV escaping', () => {
  assert.equal(escapeCSV('plain'), 'plain');
  assert.equal(escapeCSV('a,b'), '"a,b"');
  assert.equal(escapeCSV('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCSV('two\nlines'), '"two\nlines"');
  assert.equal(escapeCSV(12), '12');
  assert.equal(escapeCSV(null), '');
  assert.equal(safeText('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(safeText('Finish'), 'Finish');
});

const rows = [
  { id: 'a', bib: '7', time: newYear2021 + 1432.5, station: 'Finish', timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.0124, confidence: 1, note: '' },
  { id: 'b', bib: '12', time: newYear2021 + 1500.25, station: 'Finish, B', timing: 'manual', source: 'manual', clock: 'device', clockError: null, confidence: null, note: 'said "go"' },
];

test('simple CSV', () => {
  assert.equal(
    toCSV(rows, { format: 'simple', timeZone: 'UTC', startTime: newYear2021 }),
    'bib,time_of_day,elapsed,station\r\n7,00:23:52.500,0:23:52.500,Finish\r\n12,00:25:00.250,0:25:00.250,"Finish, B"\r\n',
  );
});

test('simple CSV without a start time leaves elapsed empty', () => {
  assert.equal(
    toCSV(rows.slice(0, 1), { format: 'simple', timeZone: 'UTC', startTime: null }),
    'bib,time_of_day,elapsed,station\r\n7,00:23:52.500,,Finish\r\n',
  );
});

test('detailed CSV', () => {
  const lines = toCSV(rows, { format: 'detailed', timeZone: 'UTC', startTime: newYear2021 }).split('\r\n');
  assert.equal(lines[0], 'position,bib,time_of_day,elapsed,utc,timing,source,confidence,clock,clock_error_ms,station,note');
  assert.equal(lines[1], '1,7,00:23:52.500,0:23:52.500,2021-01-01T00:23:52.500Z,line,camera,1.00,ntp,12,Finish,');
  assert.equal(lines[2], '2,12,00:25:00.250,0:25:00.250,2021-01-01T00:25:00.250Z,manual,manual,,device,,"Finish, B","said ""go"""');
  assert.equal(lines[3], '');
  assert.equal(lines.length, 4);
});

test('times can be written with fewer decimals, cut and never rounded up', () => {
  const moment = newYear2021 + 13 * 3600 + 20 * 60 + 2.129;
  assert.equal(timeOfDay(moment, 'UTC', 3), '13:20:02.129');
  assert.equal(timeOfDay(moment, 'UTC', 2), '13:20:02.12');
  assert.equal(timeOfDay(moment, 'UTC', 1), '13:20:02.1');
  assert.equal(timeOfDay(moment, 'UTC', 0), '13:20:02');
  // A runner is never given a better second than the one that was run.
  assert.equal(timeOfDay(newYear2021 + 59.999, 'UTC', 2), '00:00:59.99');
  assert.equal(timeOfDay(newYear2021 + 59.999, 'UTC', 0), '00:00:59');
  assert.equal(timeOfDay(newYear2021 + 0.004, 'UTC', 2), '00:00:00.00');
  // Anything outside 0 to 3 is taken as the nearest of those.
  assert.equal(timeOfDay(moment, 'UTC', 7), '13:20:02.129');
  assert.equal(timeOfDay(moment, 'UTC', -1), '13:20:02');

  assert.equal(elapsed(newYear2021, newYear2021 + 5025.678, 2), '1:23:45.67');
  assert.equal(elapsed(newYear2021, newYear2021 + 5025.678, 0), '1:23:45');
  assert.equal(elapsed(newYear2021 + 2, newYear2021 + 0.5, 1), '-0:00:01.5');
});

test('a result as a line for RunScore', () => {
  assert.equal(runScoreLine({ bib: '0542', time: '13:20:02.12', location: 'FINISH' }), 'RSBI,0542,13:20:02.12,FINISH');
  assert.equal(runScoreLine({ prefix: 'RSCI', bib: '7', time: '0:23:52.5', location: 'Finish A' }), 'RSCI,7,0:23:52.5,Finish A');
  // Nothing in a name may start a new field or a new line.
  assert.equal(runScoreLine({ bib: '7', time: '1:00:00', location: ' Start, finish\r\nRSBI,1,0:00:01,X ' }), 'RSBI,7,1:00:00,Start finish RSBI 1 0:00:01 X');
  assert.equal(runScoreLine({ bib: '1,2', time: '1:00:00', location: '' }), 'RSBI,1 2,1:00:00,');
  assert.equal(runScoreField('  Finish\t A  '), 'Finish A');
  assert.equal(runScoreField('x'.repeat(60)).length, 40);
  assert.equal(runScoreField(null), '');
});

test('names for files', () => {
  assert.equal(fileSlug('Finish A'), 'finish-a');
  assert.equal(fileSlug('Finish (2)'), 'finish-2');
  assert.equal(fileSlug('  5 km / Split  '), '5-km-split');
  assert.equal(fileSlug('***'), 'ipad');
  assert.equal(fileSlug(''), 'ipad');
  assert.ok(fileSlug('a very long station name that goes on and on and on').length <= 30);
  assert.ok(!fileSlug('abcdefghijklmnopqrstuvwxyz012 - x').endsWith('-'));
});

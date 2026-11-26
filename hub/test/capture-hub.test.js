// The capture page's dealings with a real hub (its clock, its uploads), and
// what the page makes of the texts read in each picture. The same code runs
// in the browser; here it runs without one.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Failure, HubLink, TimeKeeper, Uploader } from '../public/capture/hub.js';
import { RaceClock } from '../public/capture/lib/timesync.js';
import { detailLevels, photoRegion, scanPlan, Session, toPictureFractions } from '../public/capture/session.js';
import { defaultSettings } from '../public/capture/storage.js';
import { startHub } from '../server.js';

const key = 'correct-horse-battery';
const device = 'BBBBBBBB-0000-4000-8000-000000000002';
const start = 1_800_000_000;

let hub;
let base;

before(async () => {
  hub = await startHub({ host: '127.0.0.1', key });
  base = `http://127.0.0.1:${hub.port}`;
});

after(async () => {
  await hub.close();
});

async function until(check, what, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeout) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function crossing(id, bib, seconds, extra = {}) {
  return {
    id, bib, time: start + seconds, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.012, confidence: 0.93,
    sightings: 4, firstSeen: start + seconds - 1, lastSeen: start + seconds + 1, detectedBib: null, note: '', ...extra,
  };
}

function race(code, crossings) {
  return { id: code, name: 'Test Race', code, station: 'Finish', createdAt: start, startTime: null, crossings, roster: [], restrictToRoster: false, unsent: true };
}

/** A link to the hub that notes every upload and can be cut. */
function linkTo(address = base, withKey = key) {
  const uploads = [];
  const state = { down: false, requests: 0 };
  const link = new HubLink({
    origin: address,
    fetch: (url, options) => {
      state.requests += 1;
      if (state.down) return Promise.reject(new TypeError('fetch failed'));
      if (options.method === 'PUT') uploads.push(JSON.parse(options.body));
      return fetch(url, options);
    },
  });
  link.key = withKey;
  return { link, uploads, state };
}

const bibsOnHub = (code) => hub.store.results(code)?.rows.map((row) => row.bib) ?? null;

// ---- The link ----

test('an answer that is no, no answer, and an answer from something else are told apart', async () => {
  const good = linkTo().link;
  assert.deepEqual([(await good.ping()).access, (await good.events()).length >= 0], ['full', true]);

  await assert.rejects(linkTo(base, 'not-the-key-at-all').link.ping(), (error) => {
    assert.ok(error instanceof Failure);
    assert.deepEqual([error.status, error.turnedDown, error.unreachable], [401, true, false]);
    assert.match(error.message, /key is missing or wrong/);
    return true;
  });

  const cut = linkTo();
  cut.state.down = true;
  await assert.rejects(cut.link.ping(), (error) => error instanceof Failure && error.unreachable && !error.turnedDown && /could not be reached/.test(error.message));

  // The sign-in page of a Wi-Fi network, say, where the hub's answer should be.
  const portal = new HubLink({ fetch: async () => new Response('<html>Please sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(portal.ping(), (error) => error instanceof Failure && error.status === 502 && !error.turnedDown);

  // Trouble on the way that is not the hub's "no" is worth trying again.
  const busy = new HubLink({ fetch: async () => new Response('Bad gateway', { status: 502 }) });
  await assert.rejects(busy.ping(), (error) => error instanceof Failure && !error.turnedDown && /answered 502/.test(error.message));

  const silent = new HubLink({
    fetch: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(silent.json('/api/ping', { timeout: 40 }), (error) => error instanceof Failure && error.unreachable && /in time/.test(error.message));
});

// ---- The clock ----

test('the page\'s clock is set by the hub\'s', async () => {
  const local = () => performance.now();
  const clock = new RaceClock(local);
  const changes = [];
  const keeper = new TimeKeeper({ link: linkTo().link, clock, localNow: local, onChange: () => changes.push(keeper.syncing) });
  assert.equal(clock.at(local(), 0).source, 'device');
  assert.equal(await keeper.sync({ samples: 4 }), true);
  assert.equal(clock.isSynced, true);
  const stamp = clock.at(local(), 0);
  assert.equal(stamp.source, 'ntp');
  // The hub runs on this computer, so its time is this computer's.
  assert.ok(Math.abs(stamp.time * 1000 - Date.now()) < 60, `${stamp.time * 1000} against ${Date.now()}`);
  assert.ok(stamp.error >= 0 && stamp.error < 0.06);
  assert.equal(keeper.hubChecked, false);
  assert.equal(keeper.problem, '');
  assert.ok(keeper.lastSync !== null);
  assert.deepEqual([changes[0], changes.at(-1)], [true, false], 'whoever draws the clock hears when asking starts and ends');
});

test('without the hub the clock stays the iPad\'s own, and the reason is kept', async () => {
  const local = () => performance.now();
  const clock = new RaceClock(local);
  const cut = linkTo();
  cut.state.down = true;
  const keeper = new TimeKeeper({ link: cut.link, clock, localNow: local });
  assert.equal(await keeper.sync(), false);
  assert.equal(clock.isSynced, false);
  assert.match(keeper.problem, /could not be reached/);
  assert.equal(cut.state.requests, 1, 'a connection that is not there is not asked six times over');

  const wrong = linkTo(base, 'not-the-key-at-all');
  const refused = new TimeKeeper({ link: wrong.link, clock, localNow: local });
  assert.equal(await refused.sync(), false);
  assert.equal(wrong.state.requests, 1);
  assert.match(refused.problem, /key/);
});

test('the browser\'s own note of when a question left and its answer came is used', async () => {
  const local = () => performance.now();
  const clock = new RaceClock(local);
  const asked = [];
  const keeper = new TimeKeeper({
    link: linkTo().link, clock, localNow: local,
    // As if the browser knew the answer began to arrive 5 ms after the question left.
    refine: (path, sent, received) => {
      asked.push(path);
      return { sent: received - 5, received };
    },
  });
  assert.equal(await keeper.sync({ samples: 3 }), true);
  assert.equal(new Set(asked).size, 3, 'each question has an address of its own to be found by');
  assert.ok(asked.every((path) => /^\/api\/time\?n=\d+$/.test(path)));
  assert.ok(clock.fix.error <= 2.6, `half of 5 ms at most (${clock.fix.error})`);
});

test('a fix that can no longer be trusted is replaced, a good one is kept', async () => {
  const local = () => performance.now();
  const clock = new RaceClock(local);
  clock.adopt({ offset: 123_456, delay: 4 }, 0);
  // As over a slow connection: the answer takes 0.4 s longer than the question.
  const keeper = new TimeKeeper({ link: linkTo().link, clock, localNow: local, refine: (path, sent, received) => ({ sent: sent - 200, received: received + 200 }) });
  assert.equal(await keeper.sync({ samples: 2 }), true);
  assert.equal(clock.fix.offset, 123_456, 'a rougher measurement does not push out a finer one');
  // After the iPad has slept the fine one is simply wrong, and any new one is better.
  assert.equal(await keeper.sync({ samples: 2, replace: true }), true);
  assert.ok(Math.abs(clock.at(local(), 0).time * 1000 - Date.now()) < 60);
  assert.ok(clock.fix.error >= 200, 'and how rough it is, is known');
});

// ---- Uploads ----

test('everything is sent the first time, and after that only what has changed', async () => {
  const { link, uploads } = linkTo();
  const theRace = race('upload-changes', [crossing('A1', '1', 10), crossing('A2', '2', 11)]);
  const settled = [];
  const heard = [];
  const uploader = new Uploader({
    link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }],
    onSettled: (done) => settled.push(done.code), onChange: () => heard.push(uploader.sending),
  });
  assert.equal(uploader.waiting(theRace, 'Finish', 'UTC'), 2);
  uploader.start();
  try {
    await until(() => bibsOnHub('upload-changes')?.length === 2, 'the first upload');
    await until(() => settled.includes('upload-changes'), 'the page to hear that the hub has everything');
    assert.equal(uploads.length, 1);
    assert.deepEqual([uploads[0].full, uploads[0].crossings.length, uploads[0].station, uploads[0].raceName], [true, 2, 'Finish', 'Test Race']);
    assert.equal(uploader.waiting(theRace, 'Finish', 'UTC'), 0);
    assert.ok(uploader.lastSuccess !== null && uploader.bytes > 0);
    assert.ok(heard.includes(true) && heard.at(-1) === false);

    // One corrected, one deleted, one new.
    theRace.crossings[0] = { ...theRace.crossings[0], bib: '11' };
    theRace.crossings.splice(1, 1);
    theRace.crossings.push(crossing('A3', '3', 12));
    assert.equal(uploader.waiting(theRace, 'Finish', 'UTC'), 3);
    uploader.poke();
    await until(() => bibsOnHub('upload-changes')?.join() === '11,3', 'the changes to arrive');
    const last = uploads.at(-1);
    assert.equal(last.full, false);
    assert.deepEqual(last.crossings.map((sent) => sent.id).sort(), ['A1', 'A3']);
    assert.deepEqual(last.deleted, ['A2']);

    // A bib that is merely seen again is no news to the hub.
    theRace.crossings[1] = { ...theRace.crossings[1], lastSeen: start + 99, sightings: 9 };
    assert.equal(uploader.waiting(theRace, 'Finish', 'UTC'), 0);
    const before = uploads.length;
    uploader.poke();
    await pause(900);
    assert.equal(uploads.length, before, 'and nothing is sent for it');
  } finally {
    uploader.stop();
  }
});

test('an iPad with nothing new still says that it is there, now and then', async () => {
  const { link, uploads } = linkTo();
  const theRace = race('upload-checkin', [crossing('B1', '5', 10)]);
  let later = 0;
  const uploader = new Uploader({ link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }], now: () => Date.now() + later });
  uploader.start();
  try {
    await until(() => bibsOnHub('upload-checkin')?.length === 1, 'the first upload');
    await pause(400);
    uploader.retryNow();
    await pause(300);
    assert.equal(uploads.length, 1, 'not sooner than it is due');
    // Three quarters of a minute on.
    later = 46_000;
    uploader.retryNow();
    await until(() => uploads.length === 2, 'the check-in');
    assert.deepEqual([uploads[1].full, uploads[1].crossings, uploads[1].deleted], [false, [], []]);
    assert.ok(JSON.stringify(uploads[1]).length < 150, 'and it is a few bytes');
  } finally {
    uploader.stop();
  }
});

test('with no connection results wait on the iPad, and go when it is back', async () => {
  const { link, uploads, state } = linkTo();
  state.down = true;
  const theRace = race('upload-offline', [crossing('C1', '8', 10), crossing('C2', '9', 11)]);
  const uploader = new Uploader({ link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }] });
  uploader.start();
  try {
    await until(() => uploader.failures >= 1, 'the first attempt to fail');
    assert.match(uploader.problem, /could not be reached/);
    assert.equal(uploader.turnedDown, false);
    assert.equal(uploader.waiting(theRace, 'Finish', 'UTC'), 2);
    assert.equal(bibsOnHub('upload-offline'), null);
    // Another result while there is no connection does not make it try harder.
    const asked = state.requests;
    theRace.crossings.push(crossing('C3', '10', 12));
    uploader.poke();
    await pause(900);
    assert.equal(state.requests, asked);

    state.down = false;
    uploader.retryNow();
    await until(() => bibsOnHub('upload-offline')?.length === 3, 'everything to arrive once the connection is back');
    await until(() => uploader.failures === 0, 'the failure to be forgotten');
    assert.deepEqual([uploads.length, uploads[0].full], [1, true]);
  } finally {
    uploader.stop();
  }
});

test('a hub that says no is not asked over and over', async () => {
  const { link, state } = linkTo(base, 'not-the-key-at-all');
  const theRace = race('upload-refused', [crossing('D1', '8', 10)]);
  const uploader = new Uploader({ link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }] });
  uploader.start();
  try {
    await until(() => uploader.turnedDown, 'the refusal');
    assert.match(uploader.problem, /key/);
    theRace.crossings.push(crossing('D2', '9', 11));
    uploader.poke();
    await pause(1300);
    assert.equal(state.requests, 1, 'it waits half a minute before asking again');
    assert.equal(bibsOnHub('upload-refused'), null);
  } finally {
    uploader.stop();
  }
});

test('a hub that has lost what it had is sent everything again', async () => {
  const { link, uploads } = linkTo();
  const theRace = race('upload-lost', [crossing('E1', '21', 10), crossing('E2', '22', 11)]);
  const uploader = new Uploader({ link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }] });
  uploader.start();
  try {
    await until(() => bibsOnHub('upload-lost')?.length === 2, 'the first upload');
    assert.equal(hub.store.deleteEvent('upload-lost'), true);
    theRace.crossings.push(crossing('E3', '23', 12));
    uploader.poke();
    await until(() => bibsOnHub('upload-lost')?.length === 3, 'the hub to have everything again');
    // The change alone was sent first; the hub's count showed that it lacked the rest.
    assert.deepEqual(uploads.map((sent) => [sent.full, sent.crossings.length]), [[true, 2], [false, 1], [true, 3]]);
  } finally {
    uploader.stop();
  }
});

test('races that were left with unsent results are sent as well', async () => {
  const { link } = linkTo();
  const current = race('upload-current', [crossing('F1', '31', 10)]);
  const earlier = race('upload-earlier', [crossing('G1', '41', 10), crossing('G2', '42', 11)]);
  const settled = new Set();
  const uploader = new Uploader({
    link, deviceID: device,
    jobs: () => [current, earlier].filter((item) => item === current || item.unsent).map((item) => ({ race: item, station: item.station, timeZone: 'UTC' })),
    onSettled: (done) => {
      done.unsent = false;
      settled.add(done.code);
    },
  });
  uploader.start();
  try {
    await until(() => bibsOnHub('upload-current')?.length === 1 && bibsOnHub('upload-earlier')?.length === 2, 'both races to arrive');
    await until(() => settled.has('upload-earlier') && settled.has('upload-current'), 'both to be known as sent');
    assert.equal(earlier.unsent, false);
  } finally {
    uploader.stop();
  }
});

test('what has not been sent is handed over when the page is put away', async () => {
  const { link } = linkTo();
  const theRace = race('upload-sendoff', [crossing('H1', '51', 10)]);
  const uploader = new Uploader({ link, deviceID: device, jobs: () => [{ race: theRace, station: 'Finish', timeZone: 'UTC' }] });
  uploader.start();
  try {
    await until(() => bibsOnHub('upload-sendoff')?.length === 1, 'the first upload');
    await until(() => !uploader.sending, 'the upload to be over');
    theRace.crossings.push(crossing('H2', '52', 11));
    uploader.sendOff();
    await until(() => bibsOnHub('upload-sendoff')?.length === 2, 'the last result to arrive without being waited for');
  } finally {
    uploader.stop();
  }
});

// ---- From texts in pictures to results ----

/** A session with a clock that is moved by hand. Local times are in milliseconds. */
function sessionAt({ synced = true, deviceOffset = 7000, change = () => {} } = {}) {
  const local = { now: 50_000 };
  const clock = new RaceClock(() => local.now);
  const offset = start * 1000;
  if (synced) clock.adopt({ offset, delay: 20 }, 0);
  const settings = defaultSettings();
  change(settings);
  const theRace = race('session', []);
  const session = new Session({ clock, deviceOffset: () => deviceOffset });
  session.configure(settings, theRace);
  return { session, settings, theRace, local, offset };
}

/** Where a bib is in the picture at a local time, running down it at half its height a second. */
function bibAt(text, time, { from = 40_000, x = 0.45 } = {}) {
  const y = 0.2 + ((time - from) / 1000) * 0.5;
  return { text, confidence: 0.95, box: { x, y: y - 0.03, width: 0.1, height: 0.06 } };
}

test('a bib that crosses the line is recorded with the moment it crossed, by the hub\'s clock', () => {
  const { session, theRace, offset } = sessionAt();
  session.start();
  const changes = [];
  // Looked at every 300 ms, as a slow iPad would.
  for (let time = 40_000; time <= 42_100; time += 300) changes.push(...session.take(time, [bibAt('217', time)]).changes);
  assert.deepEqual(changes.filter((change) => change.change === 'added').map((change) => change.bib), ['217']);
  assert.equal(theRace.crossings.length, 1);
  const [result] = theRace.crossings;
  // Its middle is on the line (0.62 of the way down) 840 ms after it set off.
  assert.ok(Math.abs(result.time * 1000 - (40_840 + offset)) < 2, `${result.time * 1000 - offset}`);
  assert.deepEqual([result.bib, result.timing, result.source, result.clock], ['217', 'line', 'camera', 'ntp']);
  assert.ok(result.clockError > 0 && result.clockError < 0.05);
  assert.ok(result.firstSeen < result.time && result.lastSeen >= result.time, 'when it was first and last read is kept as time of day too');
  const added = changes.find((change) => change.change === 'added');
  assert.equal(added.id, result.id);
  assert.ok(added.box.width > 0, 'where it was in the picture comes along, for the photo');
});

test('nothing is recorded until recording is on, but the bibs are followed for the picture', () => {
  const { session, theRace } = sessionAt();
  let overlays = [];
  for (let time = 40_000; time <= 42_100; time += 300) {
    const taken = session.take(time, [bibAt('217', time)]);
    assert.deepEqual(taken.changes, []);
    overlays = taken.overlays;
  }
  assert.equal(theRace.crossings.length, 0);
  assert.deepEqual(overlays.map((drawn) => [drawn.bib, drawn.state]), [['217', 'timed']], 'the picture shows that it would have been timed');
  assert.ok(overlays[0].velocity.y > 0.4, 'and which way it is moving, to keep its box on it');
});

test('without the hub\'s clock the iPad\'s own is used, and the result says so', () => {
  const { session, theRace } = sessionAt({ synced: false, deviceOffset: 7000 });
  session.start();
  for (let time = 40_000; time <= 42_100; time += 300) session.take(time, [bibAt('8', time)]);
  const [result] = theRace.crossings;
  assert.deepEqual([result.clock, result.clockError], ['device', null]);
  assert.ok(Math.abs(result.time * 1000 - (40_840 + 7000)) < 2);
});

test('stopping gives bibs still on their way the best time there is', () => {
  const { session, theRace, offset } = sessionAt();
  session.start();
  assert.deepEqual(session.take(40_000, [bibAt('64', 40_000)]).changes, []);
  assert.deepEqual(session.take(40_300, [bibAt('64', 40_300)]).changes, []);
  const changes = session.stop();
  assert.deepEqual(changes.map((change) => [change.change, change.bib]), [['added', '64']]);
  assert.deepEqual([theRace.crossings[0].timing, Math.round(theRace.crossings[0].time * 1000 - offset)], ['estimated', 40_300]);
  assert.equal(session.recording, false);
  assert.deepEqual(session.stop(), []);
});

test('a number that is corrected after it was recorded is reported as such', () => {
  const { session, theRace } = sessionAt({ change: (settings) => { settings.timingMode = 'firstSeen'; } });
  session.start();
  const seen = [];
  // The last digit is hidden at first.
  const readings = ['12', '12', '123', '123', '123'];
  readings.forEach((text, index) => {
    const time = 40_000 + index * 300;
    seen.push(...session.take(time, [bibAt(text, time)]).changes);
  });
  // Recorded as 12, then put right. Being read again as 123 is no news.
  assert.deepEqual(seen.map((change) => [change.change, change.bibChanged]), [['added', false], ['updated', true]]);
  assert.deepEqual(theRace.crossings.map((result) => [result.bib, result.sightings]), [['123', 4]]);
  // When it has left the picture, how often it was read is filled in; the number stays.
  const gone = session.take(40_000 + 5 * 300 + 2500, []).changes;
  assert.deepEqual(gone.map((change) => [change.change, change.bibChanged]), [['updated', false]]);
  assert.deepEqual(theRace.crossings.map((result) => [result.bib, result.sightings]), [['123', 5]]);
});

test('only numbers on the start list are recorded, when that is asked for', () => {
  const { session, settings, theRace } = sessionAt();
  theRace.roster = [{ bib: '300', name: 'Ada' }];
  theRace.restrictToRoster = true;
  session.configure(settings, theRace);
  session.start();
  for (let time = 40_000; time <= 42_100; time += 300) session.take(time, [bibAt('300', time, { x: 0.2 }), bibAt('999', time, { x: 0.7 })]);
  assert.deepEqual(theRace.crossings.map((result) => result.bib), ['300']);
});

test('moving the line starts the following afresh, so that no bib is timed by half of each line', () => {
  const { session, settings, theRace } = sessionAt();
  session.start();
  session.take(40_000, [bibAt('77', 40_000)]);
  session.take(40_300, [bibAt('77', 40_300)]);
  // The line is dragged up, above where the bib is now.
  settings.line = { a: { x: 0.08, y: 0.25 }, b: { x: 0.92, y: 0.25 }, reversed: false };
  session.configure(settings, theRace);
  assert.deepEqual(session.take(40_600, [bibAt('77', 40_600)]).changes, [], 'one reading is not believed yet');
  const changes = session.take(40_900, [bibAt('77', 40_900)]).changes;
  // First read when already past the new line: its first reading after the move is the best there is.
  assert.deepEqual(changes.map((change) => change.change), ['added']);
  assert.equal(theRace.crossings[0].timing, 'estimated');
  // Changing something that has nothing to do with the line leaves the following alone.
  settings.rules.maxDigits = 4;
  session.configure(settings, theRace);
  assert.equal(session.take(41_200, [bibAt('77', 41_200)]).overlays[0].state, 'timed');
});

test('the part of the picture that is searched, and how closely', () => {
  const settings = defaultSettings();
  let plan = scanPlan(settings, 1920, 1080);
  assert.deepEqual(plan.zone, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(plan.options.maxSide, detailLevels.standard);
  assert.ok(Math.abs(plan.options.maxAspect - (0.85 * 5 + 0.8)) < 1e-9);
  assert.ok(Math.abs(plan.options.minHeight - 0.015 * 1080 * 0.7) < 1e-9);

  // A smaller area is searched at the same scale, so it is quicker and no less sharp.
  settings.scanZone = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
  plan = scanPlan(settings, 1920, 1080);
  assert.deepEqual(plan.zone, { x: 480, y: 540, width: 960, height: 540 });
  assert.equal(plan.options.maxSide, detailLevels.standard / 2);
  settings.detail = 'far';
  assert.equal(scanPlan(settings, 1920, 1080).options.maxSide, detailLevels.far / 2);
  // A small picture is never blown up.
  assert.equal(scanPlan({ ...settings, scanZone: { x: 0, y: 0, width: 1, height: 1 } }, 640, 360).options.maxSide, 640);
  // An area dragged past the edge is cut to the picture, and held upright (taller than wide) pictures work too.
  settings.scanZone = { x: 0.9, y: 0.9, width: 0.5, height: 0.5 };
  const edge = scanPlan(settings, 1080, 1920).zone;
  assert.ok(edge.x + edge.width <= 1080 && edge.y + edge.height <= 1920 && edge.width >= 1 && edge.height >= 1);

  const [text] = toPictureFractions([{ text: '42', confidence: 0.9, box: { x: 96, y: 54, width: 192, height: 108 } }], { x: 480, y: 540, width: 960, height: 540 }, 1920, 1080);
  assert.deepEqual(text, { text: '42', confidence: 0.9, box: { x: 0.3, y: 0.55, width: 0.1, height: 0.1 } });
});

test('the photo kept with a result shows the bib and some of its runner, and stays inside the picture', () => {
  const middle = photoRegion({ x: 0.45, y: 0.5, width: 0.1, height: 0.05 });
  assert.ok(middle.x <= 0.45 && middle.x + middle.width >= 0.55 && middle.y <= 0.5 && middle.y + middle.height >= 0.55);
  assert.ok(0.5 - middle.y > middle.y + middle.height - 0.55, 'more above the bib than below');
  for (const box of [{ x: 0, y: 0, width: 0.1, height: 0.05 }, { x: 0.92, y: 0.96, width: 0.08, height: 0.04 }, { x: 0.2, y: 0.2, width: 0.6, height: 0.5 }]) {
    const region = photoRegion(box);
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 + 1e-9 && region.y + region.height <= 1 + 1e-9, JSON.stringify(region));
  }
});

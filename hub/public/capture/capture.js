// The page that turns an iPad into a bib-reading camera.
//
// The camera's picture is looked at a few times a second by a program that
// finds and reads text (in a worker, see reader.js). Numbers that look like
// bibs are followed from picture to picture; when one crosses the line drawn
// on the picture its time is taken, by a clock kept in step with the results
// site's. Results are kept on the iPad and sent to the results site as they
// are made, or later if there is no connection.
//
// All text that comes from outside (race names, notes) is put on the page as
// text, never as HTML.

import { canonicalBib, parseRoster } from './lib/bibfilter.js';
import { elapsed, fileSlug, timeOfDay, toCSV } from './lib/format.js';
import { standardLine, wholePicture } from './lib/geometry.js';
import { duplicateBibs, inFinishingOrder, manualCrossing } from './lib/ledger.js';
import { eventCode, isValidCode } from './lib/planner.js';
import { RaceClock } from './lib/timesync.js';
import { Camera } from './camera.js';
import { HubLink, TimeKeeper, Uploader } from './hub.js';
import { Overlay } from './overlay.js';
import { plainReader, Reader } from './reader.js';
import { photoRegion, scanPlan, Session, toPictureFractions } from './session.js';
import { keyStorage, newRace, Storage } from './storage.js';

const $ = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

// The clock everything is timed by: it only ever runs forward, evenly.
const localNow = () => performance.now();
// What to add to it to get the iPad's own idea of the time of day.
const deviceOffset = () => Date.now() - performance.now();

// How many results the list shows unless asked for all of them.
const rowsShown = 80;
// Recording is switched on again after a reload if it was on this recently.
const resumeWithin = 12 * 3600_000;

const storage = new Storage();
const clock = new RaceClock(localNow);
const link = new HubLink();
const video = $('video');
const camera = new Camera(video);
const session = new Session({ clock, deviceOffset });

let view = null;
let copyKept = Promise.resolve();

// ---- Views ----

function show(name) {
  view = name;
  for (const id of ['trouble', 'sign-in', 'setup', 'stage']) $(id).hidden = id !== name;
  const staged = name === 'stage';
  for (const id of ['clock-chip', 'send-chip', 'open-race', 'open-settings']) $(id).hidden = !staged;
  if (!staged) $('race-title').textContent = '';
}

function showTrouble(title, text, { again = true } = {}) {
  $('trouble-title').textContent = title;
  $('trouble-text').textContent = text;
  $('trouble-again').hidden = !again;
  show('trouble');
}

// ---- Notices over the picture ----

const notices = new Map();
const closedNotices = new Map();

/**
 * Shows a message over the picture, or changes the one with the same key.
 *
 * @param {object} options `level` ('warn', 'bad' or 'info'), `action` and `run` for a button,
 *   `lasts` to take it away again after so many milliseconds, `dismiss` for a button that closes it
 */
function notice(key, text, { level = 'warn', action = null, run = null, lasts = 0, dismiss = false, about = null } = {}) {
  // Closed by hand, and nothing new to say (`about` tells one occasion from the next).
  if (about !== null && closedNotices.get(key) === about) return;
  let entry = notices.get(key);
  if (!entry) {
    const box = element('div');
    const words = element('span');
    box.append(words);
    entry = { box, words, button: null, close: null, timer: null };
    notices.set(key, entry);
    $('notices').append(box);
  }
  entry.box.className = `notice ${level}`;
  if (entry.words.textContent !== text) entry.words.textContent = text;
  if (entry.button) {
    entry.button.remove();
    entry.button = null;
  }
  if (action) {
    entry.button = element('button', null, action);
    entry.button.type = 'button';
    entry.button.addEventListener('click', run);
    entry.box.append(entry.button);
  }
  entry.about = about;
  if (dismiss && !entry.close) {
    entry.close = element('button', null, 'OK');
    entry.close.type = 'button';
    entry.close.addEventListener('click', () => {
      if (entry.about !== null) closedNotices.set(key, entry.about);
      clearNotice(key);
    });
  }
  if (entry.close) entry.box.append(entry.close);
  clearTimeout(entry.timer);
  if (lasts > 0) entry.timer = setTimeout(() => clearNotice(key), lasts);
}

function clearNotice(key) {
  const entry = notices.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.box.remove();
  notices.delete(key);
}

// ---- Times as text ----

function shownTime(seconds, decimals = 2) {
  return timeOfDay(seconds, timeZone, decimals);
}

/** Reads "9:05", "09:05:12" or "09:05:12.34" as a time of day; null if it is not one. */
function parseTimeOfDay(text) {
  const match = /^\s*(\d{1,2})[:.h](\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds, milliseconds: Number((match[4] ?? '0').padEnd(3, '0')) };
}

/** The moment on the same day as `seconds` at which the clock shows `time`. */
function onSameDay(seconds, time) {
  const date = new Date(Math.round(seconds * 1000));
  date.setHours(time.hours, time.minutes, time.seconds, time.milliseconds);
  return date.getTime() / 1000;
}

function now() {
  checkClock();
  return clock.at(localNow(), deviceOffset());
}

// ---- The clock ----

/** A better idea of when a question to the results site left and its answer came: the browser's own notes. */
function refine(path, sent, received) {
  try {
    const entries = performance.getEntriesByName(new URL(path, location.href).href, 'resource');
    const entry = entries[entries.length - 1];
    if (!entry || !(entry.requestStart > 0) || !(entry.responseStart > 0)) return null;
    if (entry.requestStart < sent - 1 || entry.responseStart > received + 1 || entry.responseStart < entry.requestStart) return null;
    return { sent: entry.requestStart, received: entry.responseStart };
  } catch {
    return null;
  }
}

const keeper = new TimeKeeper({ link, clock, localNow, refine, onChange: () => clockChanged() });

// The difference between the two clocks of the iPad when they were last
// compared. If it changes, the even-running clock has stood still (the iPad
// slept) or the time of day has been set, and what the results site said
// about the clock no longer holds.
let clocksApart = deviceOffset();

function checkClock() {
  const apart = deviceOffset();
  const jump = Math.abs(apart - clocksApart);
  if (jump < 200) return;
  clocksApart = apart;
  // A long stop makes every time wrong by as much: better the iPad's own
  // clock until the results site has been asked again.
  if (jump > 2000) clock.forget();
  keeper.sync({ replace: true });
}

function clockChanged() {
  if (!keeper.syncing && keeper.lastSync !== null) {
    clocksApart = deviceOffset();
    try {
      performance.clearResourceTimings();
    } catch {
      // Not there in every browser.
    }
  }
  drawClock();
  drawDeviceClock();
}

function drawClock() {
  const chip = $('clock-chip');
  if (clock.isSynced) {
    const error = clock.errorAt(localNow());
    chip.className = error > 250 ? 'chip warn' : 'chip good';
    chip.textContent = `Clock ±${Math.max(1, Math.round(error))} ms`;
  } else {
    chip.className = 'chip warn';
    chip.textContent = keeper.syncing ? 'Setting the clock…' : 'iPad’s own clock';
  }
}

function describeClock() {
  if (!clock.isSynced) {
    return `The clock could not be set by the results site${keeper.problem ? ` (${keeper.problem})` : ''}. ` +
      'Times come from the iPad’s own clock and are marked as such. It is tried again by itself.';
  }
  const error = Math.max(1, Math.round(clock.errorAt(localNow())));
  const ago = Math.round((localNow() - clock.fix.at) / 1000);
  return `The clock was set by the results site ${ago < 90 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago and is right to within ${error} ms. ` +
    (keeper.hubChecked
      ? 'The site checks its own clock against time servers.'
      : 'The site could not check its own clock against time servers; a hosting service’s clock is normally right to a few thousandths of a second.');
}

// ---- Sending results ----

function jobs() {
  const current = storage.race;
  const list = [];
  if (current) list.push({ race: current, station: current.station, timeZone });
  for (const race of storage.races) {
    if (race !== current && race.unsent) list.push({ race, station: race.station, timeZone });
  }
  return list;
}

const uploader = new Uploader({
  link,
  deviceID: storage.deviceID,
  jobs,
  onChange: () => drawSending(),
  onSettled: (race) => {
    if (!race.unsent) return;
    race.unsent = false;
    storage.save(5000);
  },
});

function drawSending() {
  const chip = $('send-chip');
  const race = storage.race;
  if (!race) return;
  const waiting = uploader.waiting(race, race.station, timeZone);
  if (uploader.turnedDown) {
    chip.className = 'chip bad';
    chip.textContent = 'Not accepted';
    notice('sending', `The results site did not take the results: ${uploader.problem} They are kept on this iPad.`, { level: 'bad' });
  } else if (uploader.failures >= 2) {
    chip.className = 'chip bad';
    chip.textContent = waiting > 0 ? `No connection · ${waiting} waiting` : 'No connection';
    notice('sending', 'No connection to the results site. Results are kept on this iPad and sent when the connection is back.');
  } else {
    clearNotice('sending');
    if (waiting > 0 || uploader.lastSuccess === null) {
      chip.className = 'chip';
      chip.textContent = waiting > 0 ? `Sending ${waiting}` : 'Connecting…';
    } else {
      chip.className = 'chip good';
      chip.textContent = 'Sent';
    }
  }
}

function describeSending() {
  const race = storage.race;
  const waiting = race ? uploader.waiting(race, race.station, timeZone) : 0;
  const used = `About ${uploader.bytes < 100_000 ? `${Math.max(1, Math.round(uploader.bytes / 1000))} KB` : `${(uploader.bytes / 1e6).toFixed(1)} MB`} has been sent since this page was opened.`;
  if (uploader.failures > 0) return `${uploader.problem} ${waiting} ${waiting === 1 ? 'result is' : 'results are'} waiting on this iPad. ${used}`;
  if (uploader.lastSuccess === null) return 'Nothing has been sent yet.';
  return `The results site has ${waiting === 0 ? 'everything' : `all but ${waiting}`}; it last answered at ${shownTime(uploader.lastSuccess / 1000, 0)}. ${used}`;
}

// ---- The race ----

/** Call after anything about the race in use has changed. */
function raceChanged({ urgent = true } = {}) {
  const race = storage.race;
  if (!race) return;
  if (urgent) {
    race.unsent = true;
    uploader.poke();
  }
  storage.save(urgent ? 250 : 5000);
  queueResults();
}

function drawTitle() {
  const race = storage.race;
  $('race-title').textContent = race ? `${race.name} · ${race.station}` : '';
}

function cleanName(text, most) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most);
}

// ---- Setting up ----

let hubEvents = [];

function fillRaceChoice() {
  const select = $('race-choice');
  const chosen = select.value;
  const options = [];
  const add = (value, text) => {
    const option = element('option', null, text);
    option.value = value;
    options.push(option);
  };
  add('new', 'A new race');
  const local = new Set();
  for (const race of [...storage.races].sort((a, b) => b.createdAt - a.createdAt)) {
    local.add(race.code);
    const count = race.crossings.length;
    add(`local:${race.id}`, `${race.name}: on this iPad, ${count} ${count === 1 ? 'result' : 'results'}`);
  }
  for (const event of hubEvents) {
    if (local.has(event.code)) continue;
    const ipads = event.stations?.length ?? 0;
    add(`hub:${event.code}`, `${event.name}: on the results site, ${ipads} ${ipads === 1 ? 'iPad' : 'iPads'}, ${event.count} ${event.count === 1 ? 'result' : 'results'}`);
  }
  select.replaceChildren(...options);
  const wanted = options.some((option) => option.value === chosen) ? chosen : storage.race ? `local:${storage.race.id}` : 'new';
  select.value = wanted;
  showRaceChoice();
}

/** Shows what goes with the race chosen: a name to give a new one, a way to clear an old one off the iPad. */
function showRaceChoice() {
  const choice = $('race-choice').value;
  $('race-name-field').hidden = choice !== 'new';
  $('remove-race').hidden = !choice.startsWith('local:');
}

/** Takes a race off this iPad: its results and their photos. What the results site holds stays there. */
function removeRace() {
  const choice = $('race-choice').value;
  const race = choice.startsWith('local:') ? storage.races.find((item) => item.id === choice.slice('local:'.length)) : null;
  if (!race) return;
  const count = race.crossings.length;
  const waiting = race.unsent ? uploader.waiting(race, race.station, timeZone) : 0;
  const question = `Remove “${race.name}” and its ${count} ${count === 1 ? 'result' : 'results'} from this iPad?\n\n` +
    (waiting > 0
      ? `${waiting} of them may not have reached the results site, and would be lost.`
      : 'What the results site holds stays there.');
  if (!confirm(question)) return;
  storage.deletePhotos(race.crossings.map((crossing) => crossing.id));
  storage.races = storage.races.filter((item) => item !== race);
  if (storage.currentRaceID === race.id) storage.currentRaceID = null;
  storage.saveNow();
  fillRaceChoice();
}

function openSetup() {
  show('setup');
  $('setup-problem').hidden = true;
  $('station').value = storage.race?.station || storage.settings.station;
  fillRaceChoice();
  link.events().then((events) => {
    hubEvents = events.filter((event) => isValidCode(event.code));
    if (view === 'setup') fillRaceChoice();
  }, () => {
    // Without a connection only the races on this iPad are offered.
  });
}

function setUp() {
  const problem = (text) => {
    $('setup-problem').textContent = text;
    $('setup-problem').hidden = false;
  };
  const station = cleanName($('station').value, 40);
  if (station === '') return problem('Give this iPad a place name, such as “Finish A”.');
  const choice = $('race-choice').value;
  const stamp = Date.now() / 1000;
  let race = null;
  if (choice.startsWith('local:')) {
    race = storage.races.find((item) => item.id === choice.slice('local:'.length)) ?? null;
  } else if (choice.startsWith('hub:')) {
    const event = hubEvents.find((item) => item.code === choice.slice('hub:'.length));
    if (event) {
      race = storage.races.find((item) => item.code === event.code) ?? null;
      if (!race) {
        race = newRace(cleanName(event.name, 80) || event.code, event.code, station, stamp);
        if (typeof event.startTime === 'number') race.startTime = event.startTime;
        storage.races.push(race);
      }
    }
  } else {
    const name = cleanName($('race-name').value, 80);
    if (name === '') return problem('Give the race a name.');
    const code = eventCode(name, stamp, timeZone);
    if (!isValidCode(code)) return problem('That name cannot be used. Use letters or digits.');
    // The same name on the same day is the same race.
    race = storage.races.find((item) => item.code === code) ?? null;
    if (!race) {
      race = newRace(name, code, station, stamp);
      storage.races.push(race);
    }
  }
  if (!race) return problem('That race is no longer there. Choose another.');
  if (race.station !== station) {
    race.station = station;
    race.unsent = true;
  }
  storage.settings.station = station;
  storage.currentRaceID = race.id;
  storage.saveNow();
  openStage();
  return undefined;
}

// ---- The camera and the looking ----

const scanCanvas = document.createElement('canvas');
const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
// What the scan canvas holds: which part of which size of picture.
let lastLook = null;
let looking = false;
let waitingForFrame = null;
let waitingSince = 0;
const lookTimes = [];
let lastTiming = null;

// The reader is a large program, and this page has not been tried on every
// iPad there is. If starting it, or its first looks, should ever take the
// whole page down, the page must not walk into the same thing each time it
// is loaded. So a note is kept on the iPad while the reader is being started
// and tried out. A note found when the page loads means the page went away
// at that point. Twice in a row with the quick form of the reader: the
// plain form from then on. Twice with the plain form: the reader is left off
// until it is asked for, and times can still be taken by hand.
const trialKey = 'bibtimer.capture.reader';
const trial = {
  current: null, // { program, threads, tries } for the reader now being started or tried
  looks: 0,
  held: false,
  read() {
    try {
      const left = JSON.parse(localStorage.getItem(trialKey) ?? 'null');
      return left && typeof left.program === 'string' && Number.isInteger(left.tries) ? left : null;
    } catch {
      return null;
    }
  },
  note(value) {
    try {
      if (value) localStorage.setItem(trialKey, JSON.stringify(value));
      else localStorage.removeItem(trialKey);
    } catch {
      // Nothing can be kept here; then nothing is.
    }
  },
};
const trialLooks = 3;

const reader = new Reader({
  onChange: () => {
    if (reader.state === 'loading' && reader.preparing && trial.current) {
      trial.current.program = reader.program;
      trial.note(trial.current);
    } else if (reader.state === 'ready' && trial.current && trial.looks === 0) {
      trial.current.program = reader.program;
      trial.note(null);
    }
    if (reader.state === 'ready' && reader.program === 'quick') keepPlainReaderToo();
    drawReader();
    nextLook();
  },
});

// A device that reads with the quick form goes back to the plain form if the
// quick one stops working. So that this also works without a connection, the
// plain form is fetched once in the background (about 2 MB) and kept.
let plainAskedFor = false;

function keepPlainReaderToo() {
  if (plainAskedFor || !navigator.serviceWorker?.controller) return;
  plainAskedFor = true;
  setTimeout(async () => {
    for (const file of ['/vendor/plain/ort.wasm.min.js', '/vendor/plain/ort-wasm-simd.wasm']) {
      try {
        if (await caches.match(file, { ignoreVary: true })) continue;
        // Asked for through the copy-keeper, which keeps what passes through it.
        await (await fetch(file)).arrayBuffer();
      } catch {
        // Another time.
        plainAskedFor = false;
        return;
      }
    }
  }, 8000);
}

const overlay = new Overlay($('overlay'), video, {
  settings: () => storage.settings,
  onAdjust: (finished) => {
    if (!finished) return;
    storage.save();
    session.configure(storage.settings, storage.race);
  },
});

// iPads and iPhones, whose browsers have been reported to refuse the quick
// form of the reader. (An iPad says it is a Mac; a Mac has no touch screen.)
const onAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Which form of the reader to start, and with how many processor cores. */
function readerWanted() {
  const asked = storage.settings.threads;
  // Several cores are only to be had where the page has been given leave.
  if (!globalThis.crossOriginIsolated || asked === 1) return plainReader;
  if (asked > 1) return { program: 'quick', threads: asked };
  if (onAppleMobile) return plainReader;
  return { program: 'quick', threads: (navigator.hardwareConcurrency ?? 2) >= 8 ? 4 : 2 };
}

/** Starts the reader. `asked` is true when a person asked for it, false when the page does it by itself. */
async function startReader({ asked = false } = {}) {
  // Once the copy of this page on the iPad is in charge, what the reader
  // fetches is kept as well, and need not be fetched again.
  await copyKept;
  let wanted = readerWanted();
  let tries = 1;
  const left = asked ? null : trial.read();
  if (left && left.tries >= 2 && left.program === 'quick') {
    storage.settings.threads = 1;
    storage.save();
    wanted = plainReader;
  } else if (left && left.tries >= 2) {
    trial.held = true;
    drawReader();
    return;
  } else if (left && left.program === wanted.program) {
    tries = left.tries + 1;
  }
  trial.held = false;
  trial.current = { program: wanted.program, threads: wanted.threads, tries };
  trial.looks = 0;
  trial.note(null);
  reader.start(wanted);
}

function looksPerSecond() {
  if (lookTimes.length < 2 || performance.now() - lookTimes[lookTimes.length - 1] > 3000) return null;
  return (lookTimes.length - 1) * 1000 / (lookTimes[lookTimes.length - 1] - lookTimes[0]);
}

function drawReader() {
  const chip = $('reader-chip');
  if (reader.state === 'loading') {
    chip.textContent = reader.preparing ? 'Starting the bib reader…' : `Fetching the bib reader: ${Math.round(reader.share * 100)}%`;
    clearNotice('reader');
  } else if (reader.state === 'ready') {
    const rate = looksPerSecond();
    chip.textContent = !camera.running ? 'Bib reader ready'
      : rate === null ? 'Reading' : `Reading · ${rate < 10 ? rate.toFixed(1) : Math.round(rate)} looks a second`;
    clearNotice('reader');
  } else if (reader.state === 'failed') {
    chip.textContent = 'Bib reader not working';
    notice('reader', `${reader.problem} Times can still be taken by hand with Mark.`, { level: 'bad', action: 'Try again', run: () => startReader({ asked: true }) });
  } else if (trial.held) {
    chip.textContent = 'Bib reader off';
    notice('reader', 'This page went away twice while the bib reader was starting, so the reader has been left off. Times can still be taken by hand with Mark.',
      { level: 'bad', action: 'Start it again', run: () => startReader({ asked: true }) });
  } else {
    chip.textContent = '';
  }
}

function showCameraOff(text) {
  $('camera-problem').textContent = text;
  $('camera-off').hidden = false;
}

let cameraStarting = false;

async function startCamera() {
  if (cameraStarting) return false;
  cameraStarting = true;
  $('camera-off').hidden = true;
  try {
    await camera.start(storage.settings.cameraID);
  } catch (error) {
    showCameraOff(error.message);
    return false;
  } finally {
    cameraStarting = false;
  }
  camera.delay = storage.settings.cameraDelay;
  const zoom = camera.zoomRange;
  if (zoom && typeof storage.settings.zoom === 'number' && storage.settings.zoom >= zoom.min && storage.settings.zoom <= zoom.max) {
    camera.setZoom(storage.settings.zoom);
  }
  overlay.invalidate();
  keepAwake();
  drawReader();
  nextLook();
  // Asks the browser not to clear this site's data when space runs short.
  navigator.storage?.persist?.().catch(() => {});
  return true;
}

camera.onEnded = () => {
  if (view !== 'stage') return;
  showCameraOff(session.recording
    ? 'The camera has stopped, so nothing is being read. Tap to start it again. Times can still be taken with Mark.'
    : 'The camera has stopped.');
};

/** Looks at the next picture from the camera, if everything is ready for it. */
function nextLook() {
  if (looking || waitingForFrame || view !== 'stage' || document.hidden) return;
  if (!camera.running || reader.state !== 'ready') return;
  waitingSince = performance.now();
  waitingForFrame = camera.whenFrame((time) => {
    waitingForFrame = null;
    look(time);
  });
}

function look(time) {
  const width = camera.width;
  const height = camera.height;
  if (!width || !height || reader.state !== 'ready' || view !== 'stage') {
    setTimeout(nextLook, 250);
    return;
  }
  const plan = scanPlan(storage.settings, width, height, reader.threads);
  const { zone } = plan;
  let image;
  try {
    if (scanCanvas.width !== zone.width || scanCanvas.height !== zone.height) {
      scanCanvas.width = zone.width;
      scanCanvas.height = zone.height;
    }
    scanContext.drawImage(video, zone.x, zone.y, zone.width, zone.height, 0, 0, zone.width, zone.height);
    image = scanContext.getImageData(0, 0, zone.width, zone.height);
  } catch {
    // No picture to be had just now.
    setTimeout(nextLook, 500);
    return;
  }
  lastLook = { zone, width, height };
  looking = true;
  if (trial.current && trial.looks < trialLooks) trial.note(trial.current);
  reader.scan(image.data, zone.width, zone.height, plan.options).then((result) => {
    looking = false;
    try {
      took(time, plan, result, width, height);
    } catch (error) {
      console.error(error);
    }
    // After `took`, which cuts its photos out of this picture.
    nextLook();
  }, () => {
    looking = false;
    // The reader could not take this picture. Not at once again: if it
    // keeps failing, that would be thirty times a second.
    setTimeout(nextLook, 500);
  });
}

function took(time, plan, result, width, height) {
  checkClock();
  lastTiming = result.timing;
  lookTimes.push(performance.now());
  if (lookTimes.length > 12) lookTimes.shift();
  if (trial.current && trial.looks < trialLooks) {
    trial.looks += 1;
    if (trial.looks === trialLooks) trial.note(null);
  }
  const texts = toPictureFractions(result.texts, plan.zone, width, height);
  const { changes, overlays } = session.take(time, texts);
  overlay.show(overlays, time);
  for (const change of changes) applyChange(change);
}

/** Takes in what a look, or the end of recording, did to the results. */
function applyChange(change) {
  if (change.change === 'added') {
    fresh.add(change.id);
    if (storage.settings.savePhotos && change.box) keepBibPhoto(change.id, change.box);
    raceChanged();
  } else if (change.change === 'removed') {
    storage.deletePhotos([change.id]);
    raceChanged();
  } else if (change.change === 'updated') {
    // Still in view and read again: nothing anyone needs to hear about,
    // unless the number itself has been corrected.
    raceChanged({ urgent: change.bibChanged });
  }
}

function saveCanvasAsPhoto(id, canvas) {
  try {
    canvas.toBlob((blob) => {
      if (blob) storage.savePhoto(id, blob);
    }, 'image/jpeg', 0.6);
  } catch {
    // No photo, then.
  }
}

/** Keeps the part of the picture last looked at that shows this bib and its runner. */
function keepBibPhoto(id, box) {
  if (!lastLook) return;
  const { zone, width, height } = lastLook;
  const region = photoRegion(box);
  const left = Math.max(0, region.x * width - zone.x);
  const top = Math.max(0, region.y * height - zone.y);
  const right = Math.min(zone.width, (region.x + region.width) * width - zone.x);
  const bottom = Math.min(zone.height, (region.y + region.height) * height - zone.y);
  if (right - left < 8 || bottom - top < 8) return;
  const shrink = Math.min(1, 360 / Math.max(right - left, bottom - top));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((right - left) * shrink));
  canvas.height = Math.max(1, Math.round((bottom - top) * shrink));
  try {
    canvas.getContext('2d').drawImage(scanCanvas, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
  } catch {
    return;
  }
  saveCanvasAsPhoto(id, canvas);
}

/** Keeps the whole picture as it is now, small: for a time taken by hand, to tell afterwards whose it was. */
function keepScenePhoto(id) {
  if (!camera.running || !camera.width) return;
  const shrink = Math.min(1, 640 / Math.max(camera.width, camera.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(camera.width * shrink);
  canvas.height = Math.round(camera.height * shrink);
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return;
  }
  saveCanvasAsPhoto(id, canvas);
}

// ---- Recording ----

// While recording, the time is noted on the iPad every few seconds. If the
// page is loaded again, that note says from when nothing was read.
const aliveKey = 'bibtimer.capture.alive';

function noteAlive() {
  if (!session.recording) return;
  try {
    localStorage.setItem(aliveKey, String(Date.now()));
  } catch {
    // Nothing can be kept here.
  }
}

function lastAlive() {
  try {
    const at = Number(localStorage.getItem(aliveKey));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function drawRecording() {
  const on = session.recording;
  $('record').textContent = on ? 'Stop' : 'Record';
  $('record').classList.toggle('on', on);
  $('rec-chip').hidden = !on;
}

function setRecording(on) {
  if (on === session.recording || !storage.race) return;
  if (on) {
    session.configure(storage.settings, storage.race);
    session.start();
    storage.resume = { raceID: storage.race.id, since: Date.now() };
    noteAlive();
  } else {
    for (const change of session.stop()) applyChange(change);
    storage.resume = null;
    clearNotice('resumed');
  }
  storage.saveNow();
  drawRecording();
  queueResults();
}

/** A time taken by hand, now: with a number, or without one for it to be filled in afterwards. */
function addByHand(bib) {
  const race = storage.race;
  if (!race) return;
  const stamp = now();
  const crossing = manualCrossing(bib, stamp.time, stamp);
  race.crossings.push(crossing);
  fresh.add(crossing.id);
  if (storage.settings.savePhotos) keepScenePhoto(crossing.id);
  raceChanged();
}

// ---- The list of results ----

const fresh = new Set();
const rowCache = new Map();
let showAll = false;
let resultsQueued = false;
let resultsDrawnAt = 0;

/** Draws the list again soon; at most a few times a second however often it is asked. */
function queueResults() {
  if (resultsQueued) return;
  resultsQueued = true;
  const since = performance.now() - resultsDrawnAt;
  setTimeout(() => {
    resultsQueued = false;
    resultsDrawnAt = performance.now();
    drawResults();
  }, since > 250 ? 0 : 250 - since);
}

function tagsFor(crossing) {
  const tags = [];
  if (crossing.source === 'manual') tags.push(['by hand', '']);
  else if (crossing.detectedBib != null) tags.push([`read as ${crossing.detectedBib || '?'}`, '']);
  if (crossing.timing === 'estimated') tags.push(['estimated', '']);
  if (crossing.clock === 'device') tags.push(['iPad clock', 'warn']);
  return tags;
}

function drawResults() {
  const race = storage.race;
  if (!race || view !== 'stage') return;
  const ordered = inFinishingOrder(race.crossings);
  // With laps a bib is meant to be there more than once.
  const twice = storage.settings.repeatRule.allowRepeats ? new Set() : duplicateBibs(race.crossings);
  const names = new Map(race.roster.map((entry) => [entry.bib, entry.name]));
  $('count').textContent = String(ordered.length);
  $('count-word').textContent = ordered.length === 1 ? 'result' : 'results';
  $('no-results').hidden = ordered.length > 0;

  const first = showAll ? 0 : Math.max(0, ordered.length - rowsShown);
  const kept = new Set();
  const items = [];
  // Newest at the top.
  for (let index = ordered.length - 1; index >= first; index -= 1) {
    const crossing = ordered[index];
    kept.add(crossing.id);
    const tags = tagsFor(crossing);
    const name = names.get(crossing.bib) ?? '';
    const since = race.startTime == null ? '' : elapsed(race.startTime, crossing.time, 1);
    const isTwice = crossing.bib !== '' && twice.has(crossing.bib);
    const signature = [index, crossing.bib, crossing.time, since, name, crossing.note, isTwice, tags.map((tag) => tag[0]).join('/')].join('\u0000');
    let row = rowCache.get(crossing.id);
    if (!row) {
      const item = element('li');
      const button = element('button', 'row');
      button.type = 'button';
      button.addEventListener('click', () => openEdit(crossing.id));
      const parts = {
        position: element('span', 'position'), bib: element('span', 'bib'), when: element('span', 'when'),
        other: element('span', 'other'), more: element('span', 'more'),
      };
      button.append(parts.position, parts.bib, parts.when, parts.other, parts.more);
      item.append(button);
      // Otherwise the highlight would play again each time the list is put together anew.
      item.addEventListener('animationend', () => item.classList.remove('fresh'));
      row = { item, parts, signature: null };
      rowCache.set(crossing.id, row);
    }
    if (row.signature !== signature) {
      row.signature = signature;
      row.parts.position.textContent = String(index + 1);
      row.parts.bib.textContent = crossing.bib === '' ? '?' : crossing.bib;
      row.parts.bib.className = crossing.bib === '' ? 'bib missing' : isTwice ? 'bib twice' : 'bib';
      // With a start time the time since the start comes first, and the time of day under it.
      row.parts.when.textContent = since === '' ? shownTime(crossing.time) : since;
      row.parts.other.textContent = since === '' ? '' : shownTime(crossing.time);
      const more = [];
      if (isTwice) more.push(element('span', 'tag warn', 'more than once'));
      for (const [text, kind] of tags) more.push(element('span', kind ? `tag ${kind}` : 'tag', text));
      if (name) more.push(document.createTextNode(`${name} `));
      if (crossing.note) more.push(document.createTextNode(crossing.note));
      row.parts.more.replaceChildren(...more);
    }
    if (fresh.has(crossing.id)) {
      fresh.delete(crossing.id);
      row.item.classList.remove('fresh');
      // Starts the highlight afresh if the row has been highlighted before.
      void row.item.offsetWidth;
      row.item.classList.add('fresh');
    }
    items.push(row.item);
  }
  for (const id of rowCache.keys()) {
    if (!kept.has(id)) rowCache.delete(id);
  }
  // Only put into the page again when the rows or their order have changed.
  const list = $('rows');
  if (list.children.length !== items.length || items.some((item, index) => list.children[index] !== item)) list.replaceChildren(...items);

  const hiddenRows = ordered.length - items.length;
  $('show-all').hidden = !(hiddenRows > 0 || (showAll && ordered.length > rowsShown));
  $('show-all').textContent = showAll ? `Show only the last ${rowsShown}` : `Show the ${hiddenRows} earlier results too`;
  drawSending();
  drawDeviceClock();
}

// ---- Changing one result ----

let editing = null;
let editPhotoURL = null;

function closeEdit() {
  editing = null;
  if (editPhotoURL) URL.revokeObjectURL(editPhotoURL);
  editPhotoURL = null;
  $('edit-photo').hidden = true;
  $('edit-photo').removeAttribute('src');
  if ($('edit-dialog').open) $('edit-dialog').close();
}

function openEdit(id) {
  const race = storage.race;
  const crossing = race?.crossings.find((item) => item.id === id);
  if (!crossing) return;
  closeEdit();
  editing = { id, time: shownTime(crossing.time, 3) };
  $('edit-title').textContent = crossing.bib === '' ? 'Result without a number' : `Bib ${crossing.bib}`;
  $('edit-bib').value = crossing.bib;
  $('edit-time').value = editing.time;
  $('edit-note').value = crossing.note ?? '';
  $('edit-problem').hidden = true;
  const facts = [];
  if (crossing.source === 'camera') {
    facts.push(`Read by the camera in ${crossing.sightings} ${crossing.sightings === 1 ? 'picture' : 'pictures'}` +
      `${crossing.confidence == null ? '' : `, ${Math.round(crossing.confidence * 100)}% sure`}.`);
    if (crossing.detectedBib != null) facts.push(`The camera read ${crossing.detectedBib || 'no number'}.`);
    facts.push({ line: 'Time taken as it crossed the line.', estimated: 'It was lost before it reached the line, so the time is when it was last read.',
      firstSeen: 'Time taken when it was first read.', lastSeen: 'Time taken when it was last read.', manual: 'Time typed in by hand.' }[crossing.timing] ?? '');
  } else {
    facts.push(crossing.timing === 'manual' ? 'Taken by hand.' : '');
  }
  facts.push(crossing.clock === 'ntp'
    ? `Clock set by the results site${crossing.clockError == null ? '' : `, right to within ${Math.max(1, Math.round(crossing.clockError * 1000))} ms`}.`
    : 'Timed by the iPad’s own clock.');
  $('edit-facts').textContent = facts.filter((fact) => fact !== '').join(' ');
  $('edit-dialog').showModal();
  if (crossing.bib === '') $('edit-bib').focus();
  storage.photo(id).then((blob) => {
    if (!blob || editing?.id !== id) return;
    editPhotoURL = URL.createObjectURL(blob);
    $('edit-photo').src = editPhotoURL;
    $('edit-photo').hidden = false;
  });
}

function saveEdit() {
  const race = storage.race;
  const index = race && editing ? race.crossings.findIndex((item) => item.id === editing.id) : -1;
  if (index < 0) return closeEdit();
  const problem = (text) => {
    $('edit-problem').textContent = text;
    $('edit-problem').hidden = false;
  };
  const crossing = { ...race.crossings[index] };
  const typedBib = $('edit-bib').value.trim();
  const bib = typedBib === '' ? '' : canonicalBib(typedBib);
  if (bib === null) return problem('A bib number is digits only. Leave it empty if it is not known.');
  if (bib !== crossing.bib) {
    // What the camera read is kept, and the camera does not change the number again.
    if (crossing.source === 'camera' && crossing.detectedBib == null) crossing.detectedBib = crossing.bib;
    crossing.bib = bib;
  }
  const typedTime = $('edit-time').value.trim();
  if (typedTime !== editing.time) {
    const time = parseTimeOfDay(typedTime);
    if (!time) return problem('Write the time like 10:23:45 or 10:23:45.67.');
    crossing.time = onSameDay(crossing.time, time);
    crossing.timing = 'manual';
  }
  crossing.note = cleanName($('edit-note').value, 200);
  race.crossings[index] = crossing;
  closeEdit();
  raceChanged();
  return undefined;
}

function deleteEdited() {
  const race = storage.race;
  if (!race || !editing) return;
  const id = editing.id;
  const index = race.crossings.findIndex((item) => item.id === id);
  if (index >= 0) race.crossings.splice(index, 1);
  storage.deletePhotos([id]);
  closeEdit();
  raceChanged();
}

// ---- The race sheet ----

function drawStart() {
  const race = storage.race;
  if (!race) return;
  $('start-shown').textContent = race.startTime == null ? 'No start time has been set.' : `The race started at ${shownTime(race.startTime)}.`;
  $('start-clear').hidden = race.startTime == null;
}

function drawRoster() {
  const race = storage.race;
  if (!race) return;
  const count = race.roster.length;
  $('roster-count').textContent = count === 0 ? '' : `${count} ${count === 1 ? 'runner' : 'runners'} on the list.`;
  $('roster-only').disabled = count === 0;
  $('roster-only').checked = race.restrictToRoster && count > 0;
}

/** How many results were timed by the iPad's own clock, and how far that clock is from the results site's now. */
function deviceClockResults() {
  const race = storage.race;
  if (!race || !clock.isSynced) return null;
  const count = race.crossings.reduce((sum, crossing) => sum + (crossing.clock === 'device' ? 1 : 0), 0);
  if (count === 0) return null;
  const local = localNow();
  return { count, shift: clock.at(local, 0).time - (local + deviceOffset()) / 1000 };
}

function drawDeviceClock() {
  const found = deviceClockResults();
  const paragraph = $('device-clock');
  paragraph.hidden = found === null;
  $('fix-times').hidden = found === null;
  if (!found) {
    clearNotice('device-clock');
    return;
  }
  const size = Math.abs(found.shift);
  const text = `${found.count} ${found.count === 1 ? 'result was' : 'results were'} timed by the iPad’s own clock, which is ` +
    `${size < 0.0995 ? `${Math.round(size * 1000)} ms` : `${size.toFixed(2)} s`} ${found.shift >= 0 ? 'behind' : 'ahead of'} the results site’s.`;
  paragraph.textContent = `${text} Correcting them moves their times by that much.`;
  notice('device-clock', text, { level: 'info', action: 'Correct them', run: fixDeviceClockTimes, dismiss: true, about: String(found.count) });
}

function fixDeviceClockTimes() {
  const race = storage.race;
  const found = deviceClockResults();
  if (!race || !found) return;
  // The iPad's clock may have wandered a little since each time was taken.
  const error = (clock.errorAt(localNow()) + 100) / 1000;
  race.crossings = race.crossings.map((crossing) => (crossing.clock !== 'device' ? crossing : {
    ...crossing,
    time: crossing.time + found.shift,
    firstSeen: crossing.firstSeen == null ? null : crossing.firstSeen + found.shift,
    lastSeen: crossing.lastSeen == null ? null : crossing.lastSeen + found.shift,
    clock: 'ntp',
    clockError: error,
  }));
  clearNotice('device-clock');
  raceChanged();
}

function openRace() {
  const race = storage.race;
  if (!race) return;
  $('race-name-edit').value = race.name;
  $('station-edit').value = race.station;
  $('race-code').textContent = race.code;
  $('roster-text').value = race.roster.map((entry) => (entry.name ? `${entry.bib}, ${entry.name}` : entry.bib)).join('\n');
  $('start-text').value = '';
  $('data-used').textContent = describeSending();
  drawStart();
  drawRoster();
  drawDeviceClock();
  $('race-dialog').showModal();
}

function saveFile(name, text, type) {
  const link = element('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

function downloadCSV(format) {
  const race = storage.race;
  if (!race) return;
  const rows = inFinishingOrder(race.crossings).map((crossing) => ({ ...crossing, station: race.station }));
  const csv = toCSV(rows, { format, timeZone, startTime: race.startTime });
  saveFile(`${race.code}-${fileSlug(race.station)}${format === 'detailed' ? '-details' : ''}.csv`, csv, 'text/csv');
}

// ---- Settings ----

function lookUp(path) {
  return path.split('.').reduce((value, name) => value[name], storage.settings);
}

function put(path, value) {
  const names = path.split('.');
  const last = names.pop();
  names.reduce((holder, name) => holder[name], storage.settings)[last] = value;
}

const wholeNumber = (low, high) => (text) => {
  const value = Math.round(Number(text));
  return Number.isFinite(value) && text !== '' ? Math.min(high, Math.max(low, value)) : undefined;
};

// Each control in the settings sheet: the setting it shows, how to read it,
// and what else has to happen when it changes.
const controls = [
  { id: 'set-mode', path: 'timingMode' },
  { id: 'set-sightings', path: 'minSightings', read: wholeNumber(1, 6) },
  { id: 'set-repeats', path: 'repeatRule.allowRepeats', check: true },
  { id: 'set-interval', path: 'repeatRule.minInterval', read: wholeNumber(1, 3600) },
  { id: 'set-min-digits', path: 'rules.minDigits', read: wholeNumber(1, 6) },
  { id: 'set-max-digits', path: 'rules.maxDigits', read: wholeNumber(1, 6) },
  { id: 'set-min-number', path: 'rules.minNumber', read: (text) => (text === '' ? null : wholeNumber(0, 999_999)(text)), write: (value) => value ?? '' },
  { id: 'set-max-number', path: 'rules.maxNumber', read: (text) => (text === '' ? null : wholeNumber(0, 999_999)(text)), write: (value) => value ?? '' },
  {
    id: 'set-ignored', path: 'rules.ignored',
    read: (text) => [...new Set(text.split(/[\s,;]+/).map(canonicalBib).filter((bib) => bib !== null))],
    write: (value) => value.join(', '),
  },
  { id: 'set-min-height', path: 'rules.minTextHeight', read: (text) => Number(text) },
  { id: 'set-lookalikes', path: 'rules.fixLookalikes', check: true },
  { id: 'set-detail', path: 'detail' },
  { id: 'set-photos', path: 'savePhotos', check: true },
  { id: 'set-threads', path: 'threads', read: wholeNumber(0, 8), after: () => startReader({ asked: true }) },
  {
    id: 'set-delay', path: 'cameraDelay', read: wholeNumber(0, 500),
    after: () => {
      camera.delay = storage.settings.cameraDelay;
    },
  },
];

function fillSettings() {
  for (const control of controls) {
    const input = $(control.id);
    const value = lookUp(control.path);
    if (control.check) input.checked = value === true;
    else input.value = String(control.write ? control.write(value) : value);
  }
  $('set-interval-field').hidden = !storage.settings.repeatRule.allowRepeats;
  const isolated = globalThis.crossOriginIsolated === true;
  $('about').textContent = [
    `This iPad is ${storage.deviceID.slice(0, 8)} on the results site.`,
    camera.running ? `Picture: ${camera.width} × ${camera.height}.` : '',
    reader.state === 'ready' ? `The reader uses ${reader.threads} ${reader.threads === 1 ? 'core' : 'cores'}${reader.fellBack ? ' (the quicker way did not work here)' : ''}` +
      `${lastTiming ? `; the last look took ${Math.round(lastTiming.total)} ms` : ''}.` : '',
    isolated ? '' : 'This browser gave the page only one core to read with.',
  ].filter((part) => part !== '').join(' ');
}

function settingChanged(control) {
  const input = $(control.id);
  const value = control.check ? input.checked : control.read ? control.read(input.value.trim()) : input.value;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    fillSettings();
    return;
  }
  put(control.path, value);
  const rules = storage.settings.rules;
  // The two ends of a range are kept the right way round.
  if (rules.minDigits > rules.maxDigits) {
    if (control.id === 'set-min-digits') rules.maxDigits = rules.minDigits;
    else rules.minDigits = rules.maxDigits;
  }
  if (rules.minNumber != null && rules.maxNumber != null && rules.minNumber > rules.maxNumber) {
    if (control.id === 'set-min-number') rules.maxNumber = rules.minNumber;
    else rules.minNumber = rules.maxNumber;
  }
  storage.save();
  session.configure(storage.settings, storage.race);
  overlay.invalidate();
  control.after?.();
  fillSettings();
  queueResults();
}

async function fillLenses() {
  const select = $('set-lens');
  const lenses = await camera.lenses();
  const current = camera.current;
  select.replaceChildren(...lenses.map((lens) => {
    const option = element('option', null, lens.label);
    option.value = lens.id;
    return option;
  }));
  select.disabled = lenses.length < 2;
  // Nothing to choose from where the browser does not tell the lenses apart.
  select.closest('.field').hidden = lenses.length === 0;
  if (current?.id && lenses.some((lens) => lens.id === current.id)) select.value = current.id;

  const zoom = camera.zoomRange;
  $('set-zoom-field').hidden = zoom === null;
  if (zoom) {
    const slider = $('set-zoom');
    slider.min = String(zoom.min);
    slider.max = String(zoom.max);
    slider.step = String(zoom.step);
    slider.value = String(zoom.now);
    $('set-zoom-shown').textContent = `${Number(zoom.now).toFixed(1)}×`;
  }
}

function openSettings() {
  fillSettings();
  fillLenses();
  $('settings-dialog').showModal();
}

// ---- Keeping the iPad awake, and coming back after it has been away ----

let wakeLock = null;

async function keepAwake() {
  if (!navigator.wakeLock?.request || document.hidden || view !== 'stage') return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

let hiddenAt = null;

function cameBack() {
  checkClock();
  keeper.sync();
  uploader.retryNow();
  if (view !== 'stage') return;
  keepAwake();
  if (session.recording && hiddenAt !== null && Date.now() - hiddenAt > 3000) {
    notice('away', `This page was not in front from ${shownTime(hiddenAt / 1000, 0)} to ${shownTime(Date.now() / 1000, 0)}. Nothing was read in that time.`,
      { level: 'bad', dismiss: true });
  }
  hiddenAt = null;
  if (camera.running) camera.resume().then(nextLook);
  else startCamera();
}

// Looks after things that can stop without saying so.
let beats = 0;

function heartbeat() {
  if (view !== 'stage') return;
  beats += 1;
  if (beats % 5 === 0 && !document.hidden) noteAlive();
  checkClock();
  drawClock();
  drawReader();
  if (document.hidden) return;
  if (storage.problem) notice('storage', storage.problem, { level: 'bad' });
  else clearNotice('storage');
  // The camera is on but no picture has come for a while: the browser has paused the video.
  if (waitingForFrame && performance.now() - waitingSince > 2500) {
    waitingForFrame();
    waitingForFrame = null;
    camera.resume().then(nextLook);
  } else {
    nextLook();
  }
}

// ---- The stage ----

async function openStage() {
  const race = storage.race;
  if (!race) return openSetup();
  if (!race.station) race.station = storage.settings.station;
  show('stage');
  showAll = false;
  rowCache.clear();
  $('rows').replaceChildren();
  session.configure(storage.settings, race);
  drawTitle();
  drawClock();
  drawRecording();
  drawReader();
  drawResults();
  uploader.retryNow();
  // The first version of iPadOS that can run the reader at all had a fault
  // in the very thing the reader is built on.
  if (onAppleMobile && /Version\/16\.4(?:\.\d+)? /.test(navigator.userAgent)) {
    notice('version', 'This iPad runs iPadOS 16.4, which has a fault that can stop the bib reader. Update it to 16.5 or later (Settings → General → Software Update).',
      { dismiss: true });
  }
  if (!navigator.wakeLock?.request) {
    notice('awake', 'This iPad may dim and lock its screen, which stops the camera. Set Settings → Display & Brightness → Auto-Lock to Never while timing.',
      { level: 'info', dismiss: true });
  }
  // Recording was on when the page went away: on again, whatever the camera does.
  const resume = storage.resume;
  if (resume && resume.raceID === race.id && Date.now() - resume.since < resumeWithin) {
    const until = lastAlive();
    setRecording(true);
    const back = shownTime(Date.now() / 1000, 0);
    notice('resumed', until !== null && until >= resume.since - 1000 && until < Date.now()
      ? `This page was loaded again while recording. Nothing was read from about ${shownTime(until / 1000, 0)} to ${back}. Recording is on again.`
      : `This page was loaded again while recording. Recording is on again since ${back}; nothing was read while the page was away.`,
    { level: 'bad', dismiss: true });
  } else if (resume) {
    storage.resume = null;
    storage.save();
  }
  await startCamera();
  return undefined;
}

function leaveStage() {
  setRecording(false);
  overlay.adjusting = false;
  $('adjust-tools').hidden = true;
  $('main-tools').hidden = false;
  if (waitingForFrame) waitingForFrame();
  waitingForFrame = null;
  camera.stop();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  for (const key of [...notices.keys()]) clearNotice(key);
}

// ---- The key ----

function askForKey(problem = '') {
  show('sign-in');
  $('key-problem').textContent = problem;
  $('key-problem').hidden = problem === '';
  $('key-input').value = '';
  $('key-input').focus();
}

function storedKey() {
  try {
    return localStorage.getItem(keyStorage);
  } catch {
    return null;
  }
}

function forgetKey() {
  try {
    localStorage.removeItem(keyStorage);
  } catch {
    // Nothing was kept.
  }
  link.key = '';
  uploader.forget();
}

let entered = false;

function enter() {
  if (!entered) {
    entered = true;
    keeper.start();
    uploader.start();
    startReader();
  } else {
    keeper.sync();
    uploader.retryNow();
  }
  if (storage.race) openStage();
  else openSetup();
}

async function signIn(key, { stored = false } = {}) {
  link.key = key;
  let answer;
  try {
    answer = await link.ping();
  } catch (error) {
    if (error.status === 401) {
      forgetKey();
      askForKey('That key was not accepted.');
    } else if (stored && storage.race) {
      // No connection, but there is a race on this iPad: carry on with it.
      // Results are sent when the connection is back.
      enter();
    } else if (stored) {
      showTrouble('The results site could not be reached', `${error.message} Check the connection and try again.`);
    } else {
      link.key = '';
      askForKey(error.message);
    }
    return;
  }
  if (answer.access !== 'full') {
    link.key = '';
    askForKey('That key can only view results. The iPads need the full access key.');
    return;
  }
  try {
    localStorage.setItem(keyStorage, key);
  } catch {
    // Private browsing: the key will be asked for again next time.
  }
  if (answer.capture === false) {
    showTrouble('The results site is missing its bib reader',
      'It was put on the server without the files that read numbers. Deploy it again from the repository: the build fetches them (“npm ci” in the hub folder).');
    return;
  }
  enter();
}

// ---- Before anything else ----

/** What this browser lacks that the page cannot do without; null if nothing. */
function whatIsMissing() {
  if (!window.isSecureContext) {
    return ['This page needs a secure address', 'Open it with an address that begins with https://. Browsers only give the camera to secure pages.'];
  }
  // A few bytes of a program that uses the fast arithmetic the reader is built on.
  const fastArithmetic = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  const tooOld = 'It needs iPadOS 16.5 or later (Settings → General → Software Update), or a current Chrome, Edge or Firefox on another device.';
  if (typeof WebAssembly !== 'object' || !WebAssembly.validate(fastArithmetic)) return ['This browser is too old to read bibs', tooOld];
  if (typeof Worker !== 'function' || typeof HTMLDialogElement !== 'function' || !navigator.mediaDevices?.getUserMedia) {
    return ['This browser cannot run the camera page', tooOld];
  }
  return null;
}

/** True unless this page is already open in another tab on this iPad: two would overwrite each other's results. */
async function onlyTab() {
  if (!navigator.locks?.request) return true;
  const claim = () => new Promise((resolve) => {
    navigator.locks.request('bibtimer-capture', { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Held for as long as the page stays open.
      return lock ? new Promise(() => {}) : undefined;
    }).catch(() => resolve(true));
  });
  // A page that is being loaded again may find its earlier self not quite gone yet.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await claim()) return true;
    await wait(300);
  }
  return false;
}

/** Has the browser keep a copy of the page, so that it also opens without a connection. */
async function keepCopy() {
  if (!('serviceWorker' in navigator)) return;
  const had = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) return;
    // A newer version of the page has been fetched.
    if (view === 'stage') {
      notice('update', 'A newer version of this page is ready. Load it when it suits: recording stops for a moment.', { level: 'info', action: 'Load it', run: () => location.reload(), dismiss: true });
    } else {
      location.reload();
    }
  });
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch {
    return;
  }
  if (had) return;
  // The first time: wait a moment for the copy to take charge.
  await Promise.race([
    new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
    wait(4000),
  ]);
}

function wire() {
  $('trouble-again').addEventListener('click', () => location.reload());
  $('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const key = $('key-input').value.trim();
    if (key) signIn(key);
  });

  $('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    setUp();
  });
  $('race-choice').addEventListener('change', showRaceChoice);
  $('remove-race').addEventListener('click', removeRace);

  $('camera-start').addEventListener('click', () => startCamera());
  $('record').addEventListener('click', () => setRecording(!session.recording));
  $('mark').addEventListener('click', () => addByHand(''));
  $('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const bib = canonicalBib($('add-bib').value);
    if (bib === null) return;
    addByHand(bib);
    $('add-bib').value = '';
  });
  $('show-all').addEventListener('click', () => {
    showAll = !showAll;
    drawResults();
  });

  $('adjust').addEventListener('click', () => {
    overlay.adjusting = true;
    $('main-tools').hidden = true;
    $('adjust-tools').hidden = false;
  });
  $('adjust-done').addEventListener('click', () => {
    overlay.adjusting = false;
    $('adjust-tools').hidden = true;
    $('main-tools').hidden = false;
  });
  const lineChanged = () => {
    storage.save();
    session.configure(storage.settings, storage.race);
    overlay.invalidate();
  };
  $('flip-line').addEventListener('click', () => {
    storage.settings.line = { ...storage.settings.line, reversed: !storage.settings.line.reversed };
    lineChanged();
  });
  $('reset-line').addEventListener('click', () => {
    storage.settings.line = { a: { ...standardLine.a }, b: { ...standardLine.b }, reversed: false };
    storage.settings.scanZone = { ...wholePicture };
    lineChanged();
  });

  $('clock-chip').addEventListener('click', async () => {
    await keeper.sync();
    notice('clock', describeClock(), { level: clock.isSynced ? 'info' : 'warn', lasts: 12_000, dismiss: true });
  });
  $('send-chip').addEventListener('click', () => {
    uploader.retryNow();
    notice('sent', describeSending(), { level: 'info', lasts: 12_000, dismiss: true });
  });

  // One result.
  $('edit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveEdit();
  });
  $('edit-cancel').addEventListener('click', closeEdit);
  $('edit-delete').addEventListener('click', deleteEdited);
  $('edit-dialog').addEventListener('close', closeEdit);

  // The race.
  $('open-race').addEventListener('click', openRace);
  $('race-close').addEventListener('click', () => $('race-dialog').close());
  $('race-name-edit').addEventListener('change', () => {
    const name = cleanName($('race-name-edit').value, 80);
    if (name === '') {
      $('race-name-edit').value = storage.race.name;
      return;
    }
    storage.race.name = name;
    drawTitle();
    raceChanged();
  });
  $('station-edit').addEventListener('change', () => {
    const station = cleanName($('station-edit').value, 40);
    if (station === '') {
      $('station-edit').value = storage.race.station;
      return;
    }
    storage.race.station = station;
    storage.settings.station = station;
    drawTitle();
    raceChanged();
  });
  const setStart = (seconds) => {
    storage.race.startTime = seconds;
    drawStart();
    raceChanged();
  };
  $('start-now').addEventListener('click', () => {
    const already = storage.race.startTime;
    if (already != null && !confirm(`The start time is ${shownTime(already)}. Replace it with the time now?`)) return;
    setStart(now().time);
  });
  $('start-clear').addEventListener('click', () => setStart(null));
  $('start-set').addEventListener('click', () => {
    const time = parseTimeOfDay($('start-text').value);
    if (!time) {
      $('start-shown').textContent = 'Write the start time like 09:00:00.';
      return;
    }
    $('start-text').value = '';
    setStart(onSameDay(Date.now() / 1000, time));
  });
  $('roster-text').addEventListener('change', () => {
    storage.race.roster = parseRoster($('roster-text').value);
    if (storage.race.roster.length === 0) storage.race.restrictToRoster = false;
    drawRoster();
    session.configure(storage.settings, storage.race);
    storage.save();
    queueResults();
  });
  $('roster-only').addEventListener('change', () => {
    storage.race.restrictToRoster = $('roster-only').checked;
    session.configure(storage.settings, storage.race);
    storage.save();
  });
  $('fix-times').addEventListener('click', fixDeviceClockTimes);
  $('csv-simple').addEventListener('click', () => downloadCSV('simple'));
  $('csv-detailed').addEventListener('click', () => downloadCSV('detailed'));
  $('switch-race').addEventListener('click', () => {
    if (session.recording && !confirm('Recording will stop. Go on?')) return;
    $('race-dialog').close();
    leaveStage();
    openSetup();
  });
  $('clear-results').addEventListener('click', () => {
    const race = storage.race;
    const count = race.crossings.length;
    if (count === 0 || !confirm(`Delete all ${count} results of “${race.name}” from this iPad and from the results site?`)) return;
    storage.deletePhotos(race.crossings.map((crossing) => crossing.id));
    race.crossings = [];
    raceChanged();
  });

  // Settings.
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  for (const control of controls) $(control.id).addEventListener('change', () => settingChanged(control));
  $('set-lens').addEventListener('change', async () => {
    storage.settings.cameraID = $('set-lens').value || null;
    storage.settings.zoom = null;
    storage.save();
    await startCamera();
    fillLenses();
  });
  $('set-zoom').addEventListener('input', () => {
    const value = Number($('set-zoom').value);
    $('set-zoom-shown').textContent = `${value.toFixed(1)}×`;
    camera.setZoom(value);
    storage.settings.zoom = value;
    storage.save();
  });
  $('forget-key').addEventListener('click', () => {
    if (!confirm('Forget the access key on this iPad? Results stay on the iPad but are not sent until the key is entered again.')) return;
    $('settings-dialog').close();
    leaveStage();
    forgetKey();
    askForKey();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      noteAlive();
      uploader.sendOff();
    } else {
      cameBack();
    }
  });
  window.addEventListener('pagehide', () => {
    noteAlive();
    uploader.sendOff();
  });
  window.addEventListener('online', () => {
    keeper.sync();
    uploader.retryNow();
  });
  window.addEventListener('beforeunload', (event) => {
    if (session.recording) event.preventDefault();
  });
  setInterval(heartbeat, 1000);
}

// A key can be handed over in the address, after "#key=". That part of an
// address is never sent to a server, and it is removed from view at once.
function keyFromAddress() {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (key) history.replaceState(null, '', location.pathname);
  return key;
}

async function begin() {
  const missing = whatIsMissing();
  if (missing) {
    showTrouble(missing[0], missing[1], { again: false });
    return;
  }
  if (!(await onlyTab())) {
    showTrouble('This page is already open', 'It is open in another tab or window on this iPad. Close that one, or use it: two at once would overwrite each other’s results.');
    return;
  }
  wire();
  copyKept = keepCopy();
  const fromAddress = keyFromAddress();
  const kept = storedKey();
  if (fromAddress) signIn(fromAddress);
  else if (kept) signIn(kept, { stored: true });
  else askForKey();
}

// What the page is doing, for whoever is looking into a problem (and for tests).
window.bibTimerState = () => ({
  view,
  recording: session.recording,
  reader: {
    state: reader.state, share: reader.share, program: reader.program, threads: reader.threads, fellBack: reader.fellBack,
    held: trial.held, problem: reader.problem, looksPerSecond: looksPerSecond(), timing: lastTiming,
  },
  camera: { running: camera.running, width: camera.width, height: camera.height, lens: camera.current?.label ?? null },
  clock: { synced: clock.isSynced, error: clock.isSynced ? clock.errorAt(localNow()) : null, offset: clock.fix?.offset ?? null, hubChecked: keeper.hubChecked, problem: keeper.problem },
  upload: { failures: uploader.failures, turnedDown: uploader.turnedDown, problem: uploader.problem, lastSuccess: uploader.lastSuccess, bytes: uploader.bytes },
  isolated: globalThis.crossOriginIsolated === true,
  settings: JSON.parse(JSON.stringify(storage.settings)),
  notices: [...notices.keys()],
  race: storage.race ? { name: storage.race.name, code: storage.race.code, station: storage.race.station, startTime: storage.race.startTime, results: storage.race.crossings.length } : null,
  results: storage.race ? inFinishingOrder(storage.race.crossings) : [],
});

begin();

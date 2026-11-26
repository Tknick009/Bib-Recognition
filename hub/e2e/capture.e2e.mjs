// Drives the capture page in a real browser, against a real hub, with a
// stand-in for the camera (see scene.js): signs in, sets up a race, lets
// runners with bibs cross the finish line and checks that their numbers and
// times come out right, on the page and on the hub.
//
//   node e2e/capture.e2e.mjs [--browser=chromium|webkit|firefox] [--device=ipad] [--shots=folder] [--only=name,...]
//
// With --device=ipad the browser says it is an iPad, with an iPad's screen
// and touch: the page then behaves as it does on one.
//
// Needs Playwright and its browser, which the hub itself does not; that is
// why this is not among the tests "node --test" runs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from '../server.js';

const require = createRequire(import.meta.url);
const playwright = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [name, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [name, value];
}));
const browserName = options.browser ?? 'chromium';
const asIPad = options.device === 'ipad';
const device = asIPad ? playwright.devices['iPad (gen 7) landscape'] : { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 };
// The form of the bib reader the page chooses when left to itself.
const usual = asIPad ? 'plain' : 'quick';
const shots = options.shots ?? null;
const only = options.only ? new Set(options.only.split(',')) : null;

const key = 'e2e-full-access-key';
const viewKey = 'e2e-view-only-key';
const scene = fs.readFileSync(path.join(here, 'scene.js'), 'utf8');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibtimer-e2e-'));
const hubLog = [];
const hub = await startHub({ port: 0, host: '127.0.0.1', key, viewKey, dataDir, log: (line) => hubLog.push(line) });
const base = `http://127.0.0.1:${hub.port}`;

const launchOptions = browserName === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {};
const browser = await playwright[browserName].launch(launchOptions);

const pageLogs = new Map();

async function newContext({ before = null } = {}) {
  const context = await browser.newContext({ ...device, acceptDownloads: true });
  await context.addInitScript(scene);
  if (before) await context.addInitScript(before);
  return context;
}

async function newPage(context, name) {
  const page = await context.newPage();
  const log = [];
  pageLogs.set(name, log);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') log.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => log.push(`[pageerror] ${error.stack ?? error}`));
  return page;
}

const state = (page) => page.evaluate(() => window.bibTimerState());

/** Waits until `check` returns something true, and returns it. */
async function until(check, what, timeout = 20_000) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function shot(page, name) {
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${browserName}${asIPad ? '-ipad' : ''}-${name}.png`) });
  }
}

async function hubJSON(pathname, withKey = key) {
  const response = await fetch(`${base}${pathname}`, { headers: { Authorization: `Bearer ${withKey}` } });
  return { status: response.status, body: await response.json() };
}

async function hubRows(code) {
  const { status, body } = await hubJSON(`/api/events/${code}/results.json`);
  return status === 200 ? body.rows : null;
}

/** Waits for the camera and the reader, and returns what the page says about itself. */
function cameraAndReader(page) {
  return until(async () => {
    const now = await state(page);
    if (now.reader.state === 'failed') throw new Error(`the reader failed: ${now.reader.problem}`);
    return now.reader.state === 'ready' && now.camera.running && now.camera.width > 0 ? now : null;
  }, 'the camera and the reader', 120_000);
}

/** Signs in and sets up a race; returns once the camera is on and the reader is ready. */
async function openCamera(page, { race, station, join = null, at = base }) {
  await page.goto(`${at}/capture/#key=${key}`);
  await page.waitForSelector('#setup:not([hidden])');
  if (join) {
    await until(() => page.$(`#race-choice option[value="hub:${join}"]`), 'the race on the hub to be offered');
    await page.selectOption('#race-choice', `hub:${join}`);
  } else {
    await page.fill('#race-name', race);
  }
  await page.fill('#station', station);
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('#stage:not([hidden])');
  return cameraAndReader(page);
}

/** Chooses how many processor cores the reader is to use, in the settings. */
async function chooseCores(page, cores) {
  await page.click('#open-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await page.evaluate(() => {
    document.querySelector('#settings-dialog details').open = true;
  });
  await page.selectOption('#set-threads', String(cores));
  await page.click('#settings-close');
  await page.waitForTimeout(300);
  return cameraAndReader(page);
}

/** A copy of the hub's public folder (as links) in which one file has been changed. */
function publicFolderWith(file, change) {
  const from = path.join(here, '..', 'public');
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'bibtimer-public-'));
  const mirror = (folder) => {
    fs.mkdirSync(path.join(to, folder), { recursive: true });
    for (const entry of fs.readdirSync(path.join(from, folder), { withFileTypes: true })) {
      const name = path.join(folder, entry.name);
      if (entry.isDirectory()) mirror(name);
      else if (name === file) fs.writeFileSync(path.join(to, name), change(fs.readFileSync(path.join(from, name), 'utf8')));
      // The packed copies of the changed file would still hold the original.
      else if (name !== `${file}.br` && name !== `${file}.gz`) fs.symlinkSync(path.join(from, name), path.join(to, name));
    }
  };
  mirror('');
  return to;
}

/** Sends runners down the picture and waits until they have all left it. */
async function run(page, bibs, settings = {}) {
  const leaves = await page.evaluate(([numbers, how]) => {
    window.__scene.send(numbers, how);
    const added = window.__scene.runners.slice(-numbers.length);
    // When the last one has left the picture, and a little longer for its track to end.
    return Math.max(...added.map((runner) => runner.t0 + (1.5 / runner.speed) * 1000)) - performance.now();
  }, [bibs, settings]);
  await page.waitForTimeout(leaves + 2600);
}

const truth = (page) => page.evaluate(() => window.__scene.runners.map((runner) => ({ bib: runner.bib, crossWall: runner.crossWall })));

/** The row of the list that shows this bib ("?" for a result without a number). Waits for it to be drawn. */
function rowOf(page, bib) {
  const shown = bib === '' ? '\\?' : bib;
  return page.locator('#rows .row').filter({ has: page.locator('.bib', { hasText: new RegExp(`^${shown}$`) }) }).first();
}

const tests = [];
const test = (name, body) => tests.push({ name, body });
const shared = {};

test('key', async () => {
  const context = await newContext();
  const page = await newPage(context, 'key');
  await page.goto(`${base}/capture/`);
  await page.waitForSelector('#sign-in:not([hidden])');
  await page.fill('#key-input', 'not-the-key-at-all');
  await page.click('#key-form button');
  await until(async () => (await page.textContent('#key-problem')).includes('not accepted'), 'the wrong key to be refused');
  await page.fill('#key-input', viewKey);
  await page.click('#key-form button');
  await until(async () => (await page.textContent('#key-problem')).includes('only view'), 'the view key to be refused');
  await page.fill('#key-input', key);
  await page.click('#key-form button');
  await page.waitForSelector('#setup:not([hidden])');
  // The key is kept for next time, and shared with the results page.
  assert.equal(await page.evaluate(() => localStorage.getItem('bibtimer.hub.key')), key);
  await shot(page, 'setup');
  await context.close();
});

test('capture', async () => {
  const context = await newContext();
  shared.context = context;
  const page = await newPage(context, 'ipad-a');
  shared.page = page;
  await openCamera(page, { race: 'E2E Road Race', station: 'Finish A' });
  let now = await state(page);
  shared.code = now.race.code;
  assert.match(shared.code, /^e2e-road-race-\d{8}$/);
  await until(async () => (await state(page)).clock.synced, 'the clock to be set by the hub');

  // Before recording, bibs are followed on the picture but nothing is recorded.
  await run(page, [11, 12], { gap: 500 });
  now = await state(page);
  assert.equal(now.results.length, 0, 'nothing is recorded before Record is tapped');
  assert.ok(now.reader.looksPerSecond > 0.5, `the picture is being looked at (${now.reader.looksPerSecond} looks a second)`);

  await page.click('#record');
  const bibs = [101, 102, 103, 204, 205, 306];
  await page.evaluate((numbers) => window.__scene.send(numbers, { gap: 800 }), bibs);
  await page.waitForTimeout(4300);
  await shot(page, 'recording');
  await page.waitForTimeout(9000);
  now = await state(page);
  await shot(page, 'results');
  assert.deepEqual(now.results.map((result) => result.bib), bibs.map(String), 'every bib is recorded once, in finishing order');
  const expected = new Map((await truth(page)).map((runner) => [runner.bib, runner.crossWall]));
  const offsets = now.results.map((result) => result.time * 1000 - expected.get(result.bib));
  console.log(`    times against the truth, in ms: ${offsets.map((offset) => Math.round(offset)).join(', ')}`);
  for (const [index, result] of now.results.entries()) {
    assert.equal(result.timing, 'line', `bib ${result.bib} was timed at the line`);
    assert.equal(result.clock, 'ntp', `bib ${result.bib} was timed by the hub's clock`);
    assert.ok(Math.abs(offsets[index]) < 200, `bib ${result.bib} is within 0.2 s of the truth (${Math.round(offsets[index])} ms)`);
  }
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 80, 'the times are off by the same amount, not scattered');

  // The hub has them, under this iPad's place name.
  const rows = await until(async () => {
    const found = await hubRows(shared.code);
    return found?.length === bibs.length ? found : null;
  }, 'the results to reach the hub');
  assert.deepEqual(rows.map((row) => row.bib), bibs.map(String));
  assert.ok(rows.every((row) => row.station === 'Finish A' && row.source === 'camera' && row.clock === 'ntp'));
  for (const [index, row] of rows.entries()) assert.ok(Math.abs(row.time - now.results[index].time) < 0.0011, 'the hub has the same times');
  await until(async () => (await page.textContent('#send-chip')) === 'Sent', 'the page to say everything has been sent');

  // A photo is kept with each result.
  const photos = await page.evaluate((ids) => new Promise((resolve, reject) => {
    const request = indexedDB.open('bibtimer-capture', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const store = request.result.transaction('photos', 'readonly').objectStore('photos');
      Promise.all(ids.map((id) => new Promise((done) => {
        const get = store.get(id);
        get.onsuccess = () => done(get.result?.bytes?.byteLength ?? 0);
        get.onerror = () => done(0);
      }))).then(resolve);
    };
  }), now.results.map((result) => result.id));
  assert.ok(photos.every((size) => size > 500), `each result has a photo (${photos.join(', ')} bytes)`);
});

test('by hand', async () => {
  const { page, code } = shared;
  // A time without a number, to be filled in afterwards.
  await page.click('#mark');
  await until(async () => (await state(page)).results.some((result) => result.bib === ''), 'the mark to be listed');
  await rowOf(page, '').click();
  await page.waitForSelector('#edit-dialog[open]');
  await until(() => page.$('#edit-photo:not([hidden])'), 'the photo taken with the mark');
  await shot(page, 'edit');
  await page.fill('#edit-bib', '0900');
  await page.fill('#edit-note', 'hat over the bib');
  await page.click('#edit-form button[type=submit]');
  let now = await state(page);
  const marked = now.results.find((result) => result.bib === '900');
  assert.ok(marked && marked.source === 'manual' && marked.note === 'hat over the bib', 'the mark has its number and note');

  // A number typed in as the runner passes.
  await page.fill('#add-bib', '77');
  await page.click('#add-form button');
  await until(async () => (await state(page)).results.some((result) => result.bib === '77'), 'the typed number to be listed');

  // A number the camera read wrongly is put right, and stays put.
  await rowOf(page, '103').click();
  await page.waitForSelector('#edit-dialog[open]');
  await page.fill('#edit-bib', '108');
  await page.fill('#edit-time', 'nonsense');
  await page.click('#edit-form button[type=submit]');
  await until(async () => (await page.textContent('#edit-problem')).includes('Write the time'), 'a time that is not one to be refused');
  const before = now.results.find((result) => result.bib === '103');
  const typed = await page.evaluate((seconds) => {
    const date = new Date(seconds * 1000);
    date.setSeconds(date.getSeconds() + 2, 250);
    const two = (value) => String(value).padStart(2, '0');
    return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.250`;
  }, before.time);
  await page.fill('#edit-time', typed);
  await page.click('#edit-form button[type=submit]');
  now = await state(page);
  const corrected = now.results.find((result) => result.bib === '108');
  assert.ok(corrected && corrected.detectedBib === '103' && corrected.timing === 'manual', 'the corrected number keeps what the camera read');
  assert.ok(Math.abs(corrected.time - Math.floor(before.time + 2) - 0.25) < 0.002, 'the typed time is taken');

  // One is deleted.
  await rowOf(page, '205').click();
  await page.waitForSelector('#edit-dialog[open]');
  await page.click('#edit-delete');
  now = await state(page);
  assert.ok(!now.results.some((result) => result.bib === '205'));

  const rows = await until(async () => {
    const found = await hubRows(code);
    return found?.length === now.results.length && found.some((item) => item.bib === '108') && !found.some((item) => item.bib === '205') ? found : null;
  }, 'the hub to follow the changes');
  assert.deepEqual(rows.map((item) => item.bib).sort(), now.results.map((result) => result.bib).sort());
  assert.equal(rows.find((item) => item.bib === '900').note, 'hat over the bib');
});

test('race sheet', async () => {
  const { page, code } = shared;
  await page.click('#open-race');
  await page.waitForSelector('#race-dialog[open]');
  await page.click('#start-now');
  await page.fill('#roster-text', 'bib,name\n101, Ada Runner\n102\tBen Jogger\n306;Cy Sprinter');
  await page.dispatchEvent('#roster-text', 'change');
  assert.match(await page.textContent('#roster-count'), /3 runners/);
  await shot(page, 'race');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csv-detailed')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.match(download.suggestedFilename(), new RegExp(`^${code}-finish-a-details\\.csv$`));
  assert.match(csv.split('\r\n')[0], /^position,bib,time_of_day,elapsed,utc,/);
  assert.ok(csv.includes(',101,') && csv.includes('Finish A'), 'the file has the results and the place name');
  await page.click('#race-close');
  const now = await state(page);
  assert.ok(typeof now.race.startTime === 'number');
  await until(async () => (await page.textContent('#rows')).includes('Ada Runner'), 'names from the start list to be shown');
  await until(async () => (await hubJSON(`/api/events/${code}/results.json`)).body.startTime === Math.round(now.race.startTime * 1000) / 1000
    || Math.abs((await hubJSON(`/api/events/${code}/results.json`)).body.startTime - now.race.startTime) < 1e-6, 'the hub to have the start time');
});

test('settings and the finish line', async () => {
  const { page } = shared;
  await page.click('#open-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await shot(page, 'settings');
  await page.selectOption('#set-max-digits', '2');
  await page.selectOption('#set-mode', 'firstSeen');
  await page.click('#settings-close');
  let now = await state(page);
  assert.equal(now.settings.rules.maxDigits, 2);
  const countBefore = now.results.length;
  // Three digits are no bib now; two are, and are timed when first read.
  await run(page, [555, 42], { gap: 300 });
  now = await state(page);
  assert.equal(now.results.length, countBefore + 1);
  const found = now.results.find((result) => result.bib === '42');
  assert.ok(found && found.timing === 'firstSeen', 'the two-digit bib was timed when first read');
  assert.ok(!now.results.some((result) => result.bib === '555'));

  await page.click('#open-settings');
  await page.selectOption('#set-max-digits', '5');
  await page.selectOption('#set-mode', 'line');
  await page.click('#settings-close');

  // The ends of the line and the corners of the search area can be dragged.
  await page.click('#adjust');
  await page.waitForSelector('#adjust-tools:not([hidden])');
  const box = await page.locator('#overlay').boundingBox();
  // The picture is 16:9 and sits in the middle of the view.
  const pictureHeight = Math.min(box.height, (box.width * 9) / 16);
  const pictureWidth = (pictureHeight * 16) / 9;
  const left = box.x + (box.width - pictureWidth) / 2;
  const top = box.y + (box.height - pictureHeight) / 2;
  const at = (x, y) => [left + x * pictureWidth, top + y * pictureHeight];
  await page.mouse.move(...at(0.08, 0.62));
  await page.mouse.down();
  await page.mouse.move(...at(0.2, 0.5), { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(...at(0, 0));
  await page.mouse.down();
  await page.mouse.move(...at(0.1, 0.2), { steps: 5 });
  await page.mouse.up();
  await shot(page, 'adjust');
  now = await state(page);
  assert.ok(Math.abs(now.settings.line.a.x - 0.2) < 0.02 && Math.abs(now.settings.line.a.y - 0.5) < 0.02, `the end of the line was moved (${JSON.stringify(now.settings.line.a)})`);
  assert.ok(Math.abs(now.settings.scanZone.x - 0.1) < 0.02 && Math.abs(now.settings.scanZone.y - 0.2) < 0.02, `the corner was moved (${JSON.stringify(now.settings.scanZone)})`);
  await page.click('#flip-line');
  assert.equal((await state(page)).settings.line.reversed, true);
  await page.click('#reset-line');
  now = await state(page);
  assert.deepEqual([now.settings.line.reversed, now.settings.line.a.x, now.settings.scanZone.width], [false, 0.08, 1]);
  await page.click('#adjust-done');
});

test('reload while recording', async () => {
  const { page, code } = shared;
  const before = await state(page);
  assert.equal(before.recording, true);
  await page.reload();
  await page.waitForSelector('#stage:not([hidden])');
  const now = await until(async () => {
    const found = await state(page);
    return found.reader.state === 'ready' && found.camera.running ? found : null;
  }, 'the page to be back after a reload', 120_000);
  assert.equal(now.recording, true, 'recording is on again');
  assert.ok(now.notices.includes('resumed'), 'the page says that it was away');
  assert.deepEqual(now.results.map((result) => result.id), before.results.map((result) => result.id), 'the results are still there');
  // And reading goes on.
  await run(page, [411], {});
  assert.ok((await state(page)).results.some((result) => result.bib === '411'));
  await until(async () => (await hubRows(code))?.length === before.results.length + 1, 'the hub to have the same results as the page');
});

test('without a connection', async () => {
  const { page, context, code } = shared;
  // The copy on the device is in charge, and holds what the reader needs.
  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const files = [];
    for (const name of names) files.push(...(await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname));
    return { controlled: navigator.serviceWorker.controller !== null, names, files };
  });
  assert.ok(kept.controlled, 'the page is served from its copy on the device');
  const program = usual === 'plain' ? '/vendor/plain/ort-wasm-simd.wasm' : '/vendor/ort-wasm-simd-threaded.wasm';
  for (const file of ['/capture/', '/capture/capture.js', '/vendor/detection.onnx', '/vendor/recognition.onnx', program]) {
    assert.ok(kept.files.includes(file), `${file} is kept on the device`);
  }

  await context.setOffline(true);
  const countBefore = (await state(page)).results.length;
  await run(page, [512, 513], { gap: 500 });
  let now = await state(page);
  assert.equal(now.results.length, countBefore + 2, 'reading goes on without a connection');
  await until(async () => (await page.textContent('#send-chip')).startsWith('No connection'), 'the page to say there is no connection', 30_000);
  await shot(page, 'offline');

  // Loaded again without a connection: the page, the reader and the results are all still there.
  await page.reload();
  await page.waitForSelector('#stage:not([hidden])');
  now = await until(async () => {
    const found = await state(page);
    if (found.reader.state === 'failed') throw new Error(found.reader.problem);
    return found.reader.state === 'ready' && found.camera.running ? found : null;
  }, 'the page to work when loaded without a connection', 120_000);
  assert.equal(now.results.length, countBefore + 2);
  assert.equal(now.recording, true);
  assert.equal(now.clock.synced, false);
  await run(page, [514], {});
  now = await state(page);
  const unsynced = now.results.find((result) => result.bib === '514');
  assert.ok(unsynced && unsynced.clock === 'device', 'without the hub, times come from the device and say so');

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await hubRows(code))?.length === countBefore + 3, 'everything to be sent once the connection is back', 60_000);
  await until(async () => (await state(page)).clock.synced, 'the clock to be set again');

  // The results timed by the device's own clock can be corrected in one go.
  await until(async () => (await state(page)).notices.includes('device-clock'), 'the page to offer the correction');
  await page.click('#notices .notice:has-text("own clock") button');
  now = await state(page);
  assert.ok(now.results.every((result) => result.clock === 'ntp'));
  await until(async () => (await hubRows(code)).every((row) => row.clock === 'ntp'), 'the hub to have the corrected times');
});

test('the plain reader', async () => {
  const { page } = shared;
  // One core, and the form of the reader that iPads get.
  let now = await chooseCores(page, 1);
  assert.deepEqual([now.reader.program, now.reader.threads], ['plain', 1]);
  const countBefore = now.results.length;
  await run(page, [611, 612, 613], { gap: 700 });
  now = await state(page);
  assert.deepEqual(now.results.slice(countBefore).map((result) => [result.bib, result.timing]), [['611', 'line'], ['612', 'line'], ['613', 'line']]);
  console.log(`    a look takes ${Math.round(now.reader.timing.total)} ms with the plain reader on this machine`);
  // Several cores, where the browser allows them.
  now = await chooseCores(page, 2);
  assert.deepEqual([now.reader.program, now.reader.threads, now.reader.fellBack], ['quick', 2, false]);
  await run(page, [621], {});
  assert.ok((await state(page)).results.some((result) => result.bib === '621'));
  console.log(`    and ${Math.round((await state(page)).reader.timing.total)} ms with the quick one on two cores`);
  now = await chooseCores(page, 0);
  assert.equal(now.reader.program, usual);
});

test('the quick reader is refused', async () => {
  // A hub whose quick reader fails the way it has been reported to on
  // iPads: the browser refuses the memory it asks for.
  const asked = /new WebAssembly\.Memory\(\{initial:256,maximum:\d+,shared:!0\}\)/;
  const folder = publicFolderWith(path.join('vendor', 'ort-wasm-simd-threaded.mjs'), (text) => {
    assert.match(text, asked);
    return text.replace(asked, '(()=>{throw new RangeError("Out of memory")})()');
  });
  const other = await startHub({ port: 0, host: '127.0.0.1', key, dataDir: null, publicDir: folder });
  const context = await newContext();
  try {
    const page = await newPage(context, 'refused');
    await openCamera(page, { race: 'Refused', station: 'Finish', at: `http://127.0.0.1:${other.port}` });
    const now = await chooseCores(page, 2);
    assert.deepEqual([now.reader.program, now.reader.fellBack], ['plain', true], 'the page went over to the plain reader by itself');
    await page.click('#record');
    await run(page, [808], {});
    assert.deepEqual((await state(page)).results.map((result) => result.bib), ['808']);
  } finally {
    await context.close();
    await other.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the reader took the page down', async () => {
  const seed = (note) => `
    try {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('bibtimer.capture.reader', ${JSON.stringify(JSON.stringify(note))});
      }
    } catch {}`;
  // The page went away twice while the quick reader was starting: the plain one from then on.
  let context = await newContext({ before: seed({ program: 'quick', threads: 2, tries: 2 }) });
  let page = await newPage(context, 'guard-quick');
  let now = await openCamera(page, { race: 'Guard', station: 'Finish' });
  assert.deepEqual([now.reader.program, now.settings.threads], ['plain', 1]);
  await context.close();

  // And twice with the plain one: the reader is left off, and can be asked for.
  context = await newContext({ before: seed({ program: 'plain', threads: 1, tries: 2 }) });
  page = await newPage(context, 'guard-plain');
  await page.goto(`${base}/capture/#key=${key}`);
  await page.waitForSelector('#setup:not([hidden])');
  await page.fill('#race-name', 'Guard');
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('#stage:not([hidden])');
  await until(async () => (await state(page)).reader.held, 'the reader to be left off');
  assert.equal((await state(page)).reader.state, 'idle');
  // Times can still be taken by hand.
  await page.click('#mark');
  assert.equal((await state(page)).results.length, 1);
  await page.click('#notices .notice:has-text("left off") button');
  now = await cameraAndReader(page);
  assert.equal(now.reader.held, false);
  await context.close();
});

test('second ipad', async () => {
  const { code } = shared;
  const context = await newContext();
  const page = await newPage(context, 'ipad-b');
  await openCamera(page, { station: 'Finish B', join: code });
  const now = await state(page);
  assert.equal(now.race.code, code);
  assert.equal(now.race.name, 'E2E Road Race');
  assert.ok(typeof now.race.startTime === 'number', 'the start time set on the first iPad is taken over');
  await page.click('#record');
  await run(page, [701, 702], { gap: 600 });
  await until(async () => (await hubRows(code))?.filter((row) => row.station === 'Finish B').length === 2, 'the second iPad to send its results');
  const { body } = await hubJSON(`/api/events/${code}/results.json`);
  assert.deepEqual(body.stations.map((station) => station.label).sort(), ['Finish A', 'Finish B']);
  // Each iPad's results can be had on their own.
  const csv = await (await fetch(`${base}/api/events/${code}/results.csv?stations=Finish%20B`, { headers: { Authorization: `Bearer ${key}` } })).text();
  assert.deepEqual(csv.trim().split('\r\n').slice(1).map((line) => line.split(',')[0]), ['701', '702']);

  // The same page opened twice on one device would overwrite its own results.
  const twin = await newPage(context, 'ipad-b-twin');
  await twin.goto(`${base}/capture/`);
  await twin.waitForSelector('#trouble:not([hidden])');
  assert.match(await twin.textContent('#trouble-title'), /already open/);
  await context.close();
});

test('real camera', async () => {
  if (browserName !== 'chromium') {
    console.log('    skipped: only Chromium comes with a pretend camera');
    return;
  }
  // The browser's own pretend camera, asked for the way a real one is.
  const other = await playwright.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const context = await other.newContext({ viewport: { width: 1024, height: 768 }, permissions: ['camera'] });
    await context.addInitScript('window.__realCamera = true;');
    await context.addInitScript(scene);
    const page = await context.newPage();
    const log = [];
    pageLogs.set('real-camera', log);
    page.on('pageerror', (error) => log.push(`[pageerror] ${error.stack ?? error}`));
    await openCamera(page, { race: 'Camera Check', station: 'Finish' });
    const now = await state(page);
    assert.ok(now.camera.width >= 640 && now.camera.height >= 360, `the camera gives a picture (${now.camera.width} x ${now.camera.height})`);
    await page.click('#open-settings');
    await until(async () => (await page.$$eval('#set-lens option', (items) => items.length)) >= 1, 'the lenses to be listed');
    await until(async () => (await state(page)).reader.looksPerSecond > 0.3, 'the picture to be looked at');
    await context.close();
  } finally {
    await other.close();
  }
});

let failed = 0;
try {
  for (const { name, body } of tests) {
    if (only && !only.has(name)) continue;
    const started = Date.now();
    try {
      await body();
      console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${String(error.stack ?? error).split('\n').join('\n     ')}`);
      if (shared.page && !shared.page.isClosed()) await shot(shared.page, `failed-${name.replaceAll(' ', '-')}`).catch(() => {});
      // The later steps build on the earlier ones.
      break;
    }
  }
} finally {
  for (const [name, log] of pageLogs) {
    if (log.length > 0) console.log(`--- messages from page "${name}" ---\n${log.join('\n')}`);
  }
  if (failed > 0 && hubLog.length > 0) console.log(`--- hub ---\n${hubLog.join('\n')}`);
  await browser.close().catch(() => {});
  await hub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed === 0 ? `\nAll passed in ${browserName}${asIPad ? ' as an iPad' : ''}.` : `\nFailed in ${browserName}${asIPad ? ' as an iPad' : ''}.`);
process.exit(failed === 0 ? 0 : 1);

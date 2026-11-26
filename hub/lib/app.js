// The hub's HTTP interface.
//
//   GET    /health                                   is the server up (no key needed)
//   GET    /                                         the live results page
//   GET    /capture/                                 the page that turns an iPad into a bib-reading camera
//   GET    /vendor/...                               what that page needs to read numbers (no key needed)
//   GET    /api/time                                 the hub's clock, for the iPads to set theirs by
//   GET    /api/ping                                 checks an address and key
//   GET    /api/events                               the events the hub holds
//   GET    /api/events/:code/live?since=N            what changed since revision N
//   GET    /api/events/:code/results.json            all results of an event
//   GET    /api/events/:code/results.csv             the same as a CSV file
//   GET    /api/events/:code/runscore?after=N        results to pass on to RunScore, in order
//   GET    /api/events/:code/runscore.txt            all results as RunScore lines, as a file
//   GET    /runscore.ps1                             the program that passes them on (no key needed)
//   PUT    /api/events/:code/sources/:device         an iPad sends its results
//   DELETE /api/events/:code                         removes an event from the hub
//
// Everything under /api needs the access key, sent as "Authorization: Bearer
// <key>" or as "?key=<key>" in the address. A separate view key, if one is
// set, can read but not change anything.
//
// Replies are kept small, because the scoring computer may be on a metered
// connection: unchanged data is answered with "304 Not Modified", the live
// page is sent only what changed, and larger replies are compressed.

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { HubClock } from './ntp.js';
import { isDeviceID, isEventCode } from './store.js';
import { elapsed, fileSlug, isTimeZone, runScoreField, runScoreLine, timeOfDay, toCSV } from './format.js';

const maxBodyBytes = 8 * 1024 * 1024;
const compressFromBytes = 1024;
// A reader of the RunScore feed may ask the hub to hold its answer until there
// is something to pass on: for at most this long, so that no network in
// between gives up on the request, and looking this often.
const longestWaitSeconds = 25;
const waitCheckEvery = 400;
const mostWaiting = 100;

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/runscore.ps1': ['runscore.ps1', 'text/plain; charset=utf-8'],
};

const typesByExtension = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

// The results page loads nothing from anywhere else and runs no inline script.
const pagePolicy = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// The capture page also runs the number-reading program (WebAssembly, in
// workers, some of them started from a copy the page holds: "blob:"), shows
// the camera, and keeps pictures of bibs.
const capturePolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; " +
  "img-src 'self' blob: data:; media-src 'self' blob: mediastream:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// With these the browser lets the number-reading program use several
// processor cores at once, which makes it several times faster.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Every file below a folder, as paths relative to it with forward slashes. */
function filesBelow(folder, prefix = '') {
  let found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) found = found.concat(filesBelow(path.join(folder, entry.name), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  // Hashing first makes the comparison take the same time whatever was sent.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
}

/** Sends a reply, compressed when that is worth it and the reader can take it. */
function send(req, res, status, headers, body) {
  let payload = body;
  const extra = {};
  if (payload !== undefined && payload !== null) {
    if (typeof payload === 'string') payload = Buffer.from(payload);
    if (payload.length >= compressFromBytes) {
      extra.Vary = 'Accept-Encoding';
      if (acceptsGzip(req)) {
        payload = gzipSync(payload);
        extra['Content-Encoding'] = 'gzip';
      }
    }
    extra['Content-Length'] = payload.length;
  }
  res.writeHead(status, { ...securityHeaders, ...headers, ...extra });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function sendJSON(req, res, status, value, headers = {}) {
  send(req, res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(value));
}

function sendError(req, res, status, message) {
  sendJSON(req, res, status, { error: message });
}

/** Answers "nothing has changed" if the reader already holds this version. */
function notModified(req, res, tag) {
  if (req.headers['if-none-match'] !== tag) return false;
  send(req, res, 304, { ETag: tag, 'Cache-Control': 'no-store' });
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('The upload is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {import('./store.js').Store} options.store
 * @param {string} options.key the access key; uploads and reads
 * @param {string} [options.viewKey] an optional second key that can only read
 * @param {string} options.publicDir where the live page's files are
 */
export function createHandler({ store, key, viewKey = '', publicDir, log = () => {}, clock = new HubClock() }) {
  const files = new Map();
  for (const [route, [name, type]] of Object.entries(staticFiles)) {
    const body = fs.readFileSync(path.join(publicDir, name));
    files.set(route, { body, type, tag: `"${shortHash(body)}"`, policy: pagePolicy });
  }

  // The capture page: its own files, and the program and models it reads
  // numbers with. Those are large and are sent from disk, in a form that was
  // compressed when they were installed.
  const captureFiles = [];
  for (const name of filesBelow(path.join(publicDir, 'capture'))) {
    const type = typesByExtension[path.extname(name)];
    if (!type || name === 'sw.js') continue;
    const body = fs.readFileSync(path.join(publicDir, 'capture', name));
    const route = name === 'index.html' ? '/capture/' : `/capture/${name}`;
    files.set(route, { body, type, tag: `"${shortHash(body)}"`, isolated: true, policy: name.endsWith('.html') ? capturePolicy : null });
    captureFiles.push(route);
  }
  const vendorFiles = [];
  for (const name of filesBelow(path.join(publicDir, 'vendor'))) {
    const type = typesByExtension[path.extname(name)];
    if (!type) continue; // among them the compressed copies, which are not addresses of their own
    const file = path.join(publicDir, 'vendor', name);
    const variants = { identity: { file, size: fs.statSync(file).size } };
    for (const [encoding, extension] of [['br', '.br'], ['gzip', '.gz']]) {
      if (fs.existsSync(file + extension)) variants[encoding] = { file: file + extension, size: fs.statSync(file + extension).size };
    }
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(file));
    files.set(`/vendor/${name}`, { type, variants, hash: hash.digest('hex').slice(0, 16), isolated: true, policy: null });
    vendorFiles.push(`/vendor/${name}`);
  }
  // Whether the capture page can read bibs: only if everything it needs was installed.
  const canCapture = [
    'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'plain/ort.wasm.min.js', 'plain/ort-wasm-simd.wasm',
    'detection.onnx', 'recognition.onnx', 'characters.txt',
  ].every((name) => files.has(`/vendor/${name}`)) && files.has('/capture/');
  if (files.has('/capture/') && !canCapture) {
    log('the capture page cannot read bibs: its files are missing from public/vendor (run "npm install" in the hub folder)');
  }

  // The capture page keeps a copy of itself on the iPad, so that it opens
  // without a connection. This is what to keep, in two groups, each with a
  // version that changes whenever any file in it does: the page's own files
  // (small, fetched at once) and what it reads numbers with (large, kept as
  // it is first used, and not fetched again because the page has changed).
  const versionOf = (routes) => shortHash(routes.map((route) => `${route}:${files.get(route).tag ?? files.get(route).hash}`).join('|'));
  const kept = [
    { name: 'page', version: versionOf(captureFiles), eager: true, files: captureFiles },
    { name: 'reader', version: versionOf(vendorFiles), eager: false, files: vendorFiles },
  ];
  const workerFile = path.join(publicDir, 'capture', 'sw.js');
  if (fs.existsSync(workerFile)) {
    const body = Buffer.from(fs.readFileSync(workerFile, 'utf8').replace("'__GROUPS__'", JSON.stringify(kept)));
    files.set('/capture/sw.js', { body, type: typesByExtension['.js'], tag: `"${shortHash(body)}"`, isolated: true, policy: null });
  }

  /** Sends one of the large files, in the most compact form the reader takes. */
  function sendFromDisk(req, res, file) {
    const accepted = String(req.headers['accept-encoding'] ?? '');
    const encoding = /\bbr\b/.test(accepted) && file.variants.br ? 'br' : /\bgzip\b/.test(accepted) && file.variants.gzip ? 'gzip' : 'identity';
    const variant = file.variants[encoding];
    const tag = `"${file.hash}-${encoding}"`;
    const headers = {
      ...securityHeaders, ...isolation,
      'Content-Type': file.type,
      'Cache-Control': 'no-cache',
      ETag: tag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = variant.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(variant.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function accessLevel(req, url) {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : url.searchParams.get('key') ?? '';
    if (sameSecret(given, key)) return 'full';
    if (sameSecret(given, viewKey)) return 'view';
    return null;
  }

  function list(url, ...names) {
    for (const name of names) {
      // An empty list is a real answer ("none of them"), a missing one is not.
      if (url.searchParams.has(name)) {
        return url.searchParams.get(name).split(',').map((item) => item.trim()).filter((item) => item !== '');
      }
    }
    return null;
  }

  function resultsOptions(url) {
    return {
      stations: list(url, 'stations', 'station'),
      devices: list(url, 'devices'),
      firstPerBib: url.searchParams.get('dedupe') === 'first',
    };
  }

  function wholeNumber(url, name, { min, max, fallback }) {
    const raw = url.searchParams.get(name) ?? '';
    if (!/^\d{1,15}$/.test(raw)) return fallback;
    return Math.min(max, Math.max(min, Number(raw)));
  }

  /** The file name for a download: the event, and the iPad if the rows are from just one. */
  function downloadName(code, results, options) {
    const narrowed = options.stations !== null || options.devices !== null;
    return narrowed && results.included.length === 1 ? `${code}-${fileSlug(results.included[0])}` : code;
  }

  // ---- RunScore ----

  /** How results are to be written for RunScore, as asked for in the address. */
  function runScoreOptions(url) {
    const prefix = url.searchParams.get('prefix') ?? '';
    return {
      prefix: /^[A-Za-z]{1,10}$/.test(prefix) ? prefix.toUpperCase() : 'RSBI',
      // One name for every result; without it, each result carries the name of its iPad.
      location: runScoreField(url.searchParams.get('location') ?? ''),
      decimals: wholeNumber(url, 'decimals', { min: 0, max: 3, fallback: 2 }),
      elapsed: url.searchParams.get('time') === 'elapsed',
      timeZone: url.searchParams.get('tz'),
    };
  }

  const needsStartTime = 'Times since the start were asked for, but no start time has been set on an iPad. Set one, or ask for the time of day.';

  /** Writes times and lines the way `options` ask, for an event's time zone and start. */
  function runScoreWriter(options, { timeZone, startTime }) {
    const zone = isTimeZone(options.timeZone) ? options.timeZone : isTimeZone(timeZone) ? timeZone : 'UTC';
    const time = (seconds) => (options.elapsed
      ? elapsed(startTime, seconds, options.decimals)
      : timeOfDay(seconds, zone, options.decimals));
    const line = (bib, seconds, station) => runScoreLine({
      prefix: options.prefix, bib, time: time(seconds), location: options.location || station,
    });
    return { time, line };
  }

  /** A feed entry as the program that passes results on needs it: the line to send, and what to tell the operator. */
  function describeEntry(entry, writer) {
    const was = entry.was;
    if (entry.kind === 'gone') {
      return {
        seq: entry.seq,
        line: null,
        note: `Removed on the iPad (${entry.station}) after it was passed on: bib ${was.bib} at ${writer.time(was.time)}. Take it out in RunScore.`,
      };
    }
    const notes = [];
    if (was && was.bib !== entry.bib) {
      notes.push(`Corrected on the iPad (${entry.station}): bib ${was.bib} at ${writer.time(was.time)} should be bib ${entry.bib}. ` +
        `Bib ${entry.bib} is passed on now; take bib ${was.bib} at that time out in RunScore.`);
    } else if (was) {
      notes.push(`Time corrected on the iPad (${entry.station}): bib ${entry.bib} was passed on at ${writer.time(was.time)} and is now ` +
        `${writer.time(entry.time)}. Take the earlier time out in RunScore.`);
    }
    // Worded the same for every result of that iPad, so that whoever reads
    // the notes can show it once instead of once per result.
    if (entry.unsynced) {
      notes.push(`${entry.station} is not synced to a time server: its times come from the iPad's own clock and may be off. ` +
        'The camera page fills in the exact times by itself once its clock is set, if it has stayed open since; in the app, correct them under Race setup.');
    }
    return { seq: entry.seq, line: writer.line(entry.bib, entry.time, entry.station), note: notes.join(' ') };
  }

  /** What to answer a reader of the feed right now; null if the event is gone. */
  function feedReply(code, url) {
    const options = runScoreOptions(url);
    const result = store.feed(code, {
      after: wholeNumber(url, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
      feedID: url.searchParams.get('feed'),
      settle: wholeNumber(url, 'settle', { min: 0, max: 300, fallback: 8 }),
      limit: wholeNumber(url, 'limit', { min: 1, max: 1000, fallback: 500 }),
      stations: list(url, 'stations', 'station'),
      devices: list(url, 'devices'),
    });
    if (!result) return null;
    if (options.elapsed && result.startTime === null) return { problem: needsStartTime };
    const writer = runScoreWriter(options, result);
    return { feed: result.feedID, next: result.next, entries: result.entries.map((entry) => describeEntry(entry, writer)) };
  }

  // Readers waiting for something to pass on. Results join the feed by time
  // passing as much as by arriving, so the waiting list is simply looked
  // through a few times a second for as long as anyone is on it.
  const waiting = new Set();
  let waitTimer = null;

  function lookThroughWaiting() {
    const now = Date.now();
    for (const reader of [...waiting]) {
      let reply;
      try {
        reply = reader.reply();
      } catch (error) {
        log(`feed request failed: ${error.stack ?? error}`);
        waiting.delete(reader);
        if (!reader.res.headersSent) sendError(reader.req, reader.res, 500, 'The hub ran into a problem handling this request.');
        continue;
      }
      if (reply === null || reply.problem || reply.entries.length > 0 || now >= reader.until) {
        waiting.delete(reader);
        reader.answer(reply);
      }
    }
    if (waiting.size === 0 && waitTimer) {
      clearInterval(waitTimer);
      waitTimer = null;
    }
  }

  function waitForFeed(reader) {
    waiting.add(reader);
    // A reader that has gone away is not kept waiting for.
    reader.res.on('close', () => waiting.delete(reader));
    if (!waitTimer) {
      waitTimer = setInterval(lookThroughWaiting, waitCheckEvery);
      waitTimer.unref();
    }
  }

  /** The address without the key, so two readers with different keys share a version tag. */
  function queryWithoutKey(url) {
    const query = new URLSearchParams(url.searchParams);
    query.delete('key');
    return query.toString();
  }

  async function handleAPI(req, res, url, arrived) {
    if (!key) {
      sendError(req, res, 503, 'This hub has no access key yet. Set the HUB_KEY variable on the server and restart it.');
      return;
    }
    const level = accessLevel(req, url);
    if (!level) {
      sendError(req, res, 401, 'The access key is missing or wrong.');
      return;
    }

    let segments; // segments[0] is "api"
    try {
      segments = url.pathname.split('/').filter((part) => part !== '').map(decodeURIComponent);
    } catch {
      sendError(req, res, 400, 'The address is not valid.');
      return;
    }

    if (segments.length === 2 && segments[1] === 'ping' && req.method === 'GET') {
      sendJSON(req, res, 200, { ok: true, access: level, store: store.storeID, persistent: store.persistent, capture: canCapture });
      return;
    }

    if (segments.length === 2 && segments[1] === 'time' && req.method === 'GET') {
      // When the question arrived and when the answer leaves, by the hub's
      // clock: from these and its own two notes the asker works out the
      // difference between the clocks. `error` is how far off the hub's own
      // clock may be, in milliseconds; null if it has never been checked.
      const error = clock.error;
      sendJSON(req, res, 200, { received: arrived, sent: clock.time(), error: error === null ? null : Math.round(error * 10) / 10, checked: clock.checked });
      return;
    }

    if (segments.length === 2 && segments[1] === 'events' && req.method === 'GET') {
      sendJSON(req, res, 200, { store: store.storeID, now: Date.now(), events: store.listEvents() });
      return;
    }

    if (segments[1] !== 'events' || segments.length < 3) {
      sendError(req, res, 404, 'There is nothing at this address.');
      return;
    }
    const code = segments[2];
    if (!isEventCode(code)) {
      sendError(req, res, 400, 'An event code is 3 to 50 lower-case letters, digits and hyphens.');
      return;
    }

    if (segments.length === 3 && req.method === 'DELETE') {
      if (level !== 'full') return sendError(req, res, 403, 'This key can only view results.');
      if (!store.deleteEvent(code)) return sendError(req, res, 404, 'The hub has no event with this code.');
      sendJSON(req, res, 200, { ok: true });
      return;
    }

    if (segments.length === 5 && segments[3] === 'sources' && req.method === 'PUT') {
      if (level !== 'full') return sendError(req, res, 403, 'This key can only view results.');
      const device = segments[4];
      if (!isDeviceID(device)) return sendError(req, res, 400, 'The device identifier is not valid.');
      let push;
      try {
        push = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (error) {
        return sendError(req, res, error.status ?? 400, error.status ? error.message : 'The upload is not valid JSON.');
      }
      if (push === null || typeof push !== 'object' || Array.isArray(push)) {
        return sendError(req, res, 400, 'The upload must be a JSON object.');
      }
      const result = store.applyPush(code, device, push);
      if (result.error) return sendError(req, res, 409, result.error);
      sendJSON(req, res, 200, result);
      return;
    }

    if (req.method !== 'GET' || segments.length !== 4) {
      sendError(req, res, 404, 'There is nothing at this address.');
      return;
    }
    const noSuchEvent = 'The hub has no event with this code yet. It appears when an iPad first sends results.';

    if (segments[3] === 'live') {
      if (!store.hasEvent(code)) return sendError(req, res, 404, noSuchEvent);
      // A reader that last saw another store (the hub has lost its data
      // since) cannot be sent a difference; it gets everything.
      const sameStore = url.searchParams.get('store') === store.storeID;
      const since = sameStore && /^\d{1,15}$/.test(url.searchParams.get('since') ?? '') ? Number(url.searchParams.get('since')) : null;
      // Changes with the results and with each check-in from an iPad.
      const tag = `"${store.storeID}:${store.revision(code)}:${store.lastHeard(code)}:${since ?? 'all'}"`;
      if (notModified(req, res, tag)) return;
      sendJSON(req, res, 200, { store: store.storeID, now: Date.now(), ...store.changes(code, since) }, { ETag: tag });
      return;
    }

    if (segments[3] === 'runscore') {
      const noSuchEventNow = 'The hub no longer has an event with this code.';
      const answer = (reply) => {
        if (reply === null) return sendError(req, res, 404, noSuchEventNow);
        if (reply.problem) return sendError(req, res, 409, reply.problem);
        sendJSON(req, res, 200, { now: Date.now(), ...reply });
      };
      const first = feedReply(code, url);
      if (first === null) return sendError(req, res, 404, noSuchEvent);
      const wait = wholeNumber(url, 'wait', { min: 0, max: longestWaitSeconds, fallback: 0 });
      if (first.problem || first.entries.length > 0 || wait === 0 || waiting.size >= mostWaiting) return answer(first);
      waitForFeed({ req, res, until: Date.now() + wait * 1000, reply: () => feedReply(code, url), answer });
      return;
    }

    if (segments[3] === 'runscore.txt') {
      if (!store.hasEvent(code)) return sendError(req, res, 404, noSuchEvent);
      const filter = resultsOptions(url);
      const results = store.results(code, filter);
      const options = runScoreOptions(url);
      if (options.elapsed && results.startTime === null) return sendError(req, res, 409, needsStartTime);
      const writer = runScoreWriter(options, results);
      const lines = results.rows.filter((row) => row.bib !== '').map((row) => writer.line(row.bib, row.time, row.station));
      send(req, res, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadName(code, results, filter)}-runscore.txt"`,
        'Cache-Control': 'no-store',
      }, lines.map((line) => `${line}\r\n`).join(''));
      return;
    }

    const isJSON = segments[3] === 'results.json';
    const isCSV = segments[3] === 'results.csv';
    if (isJSON || isCSV) {
      if (!store.hasEvent(code)) return sendError(req, res, 404, noSuchEvent);
      const tag = `"${store.storeID}:${store.revision(code)}:${shortHash(queryWithoutKey(url))}"`;
      if (notModified(req, res, tag)) return;
      const filter = resultsOptions(url);
      const results = store.results(code, filter);

      if (isJSON) {
        sendJSON(req, res, 200, { store: store.storeID, now: Date.now(), ...results }, { ETag: tag });
        return;
      }
      const requestedZone = url.searchParams.get('tz');
      const timeZone = isTimeZone(requestedZone) ? requestedZone : isTimeZone(results.timeZone) ? results.timeZone : 'UTC';
      const csv = toCSV(results.rows, {
        format: url.searchParams.get('format') === 'detailed' ? 'detailed' : 'simple',
        timeZone,
        startTime: results.startTime,
      });
      send(req, res, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadName(code, results, filter)}.csv"`,
        'Cache-Control': 'no-store',
        ETag: tag,
      }, csv);
      return;
    }

    sendError(req, res, 404, 'There is nothing at this address.');
  }

  return async function handle(req, res) {
    // Noted first of all, for readers that set their clock by the hub's.
    const arrived = clock.time();
    let url;
    try {
      url = new URL(req.url, 'http://hub.invalid');
    } catch {
      sendError(req, res, 400, 'The address is not valid.');
      return;
    }

    try {
      if (url.pathname === '/health') {
        sendJSON(req, res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleAPI(req, res, url, arrived);
        return;
      }
      if (url.pathname === '/capture' && files.has('/capture/')) {
        // With the slash at the end, so that the page's own files are found next to it.
        send(req, res, 308, { Location: '/capture/' });
        return;
      }
      const file = files.get(url.pathname);
      if (file && (req.method === 'GET' || req.method === 'HEAD')) {
        if (file.variants) {
          sendFromDisk(req, res, file);
          return;
        }
        const headers = {
          'Content-Type': file.type,
          // The browser keeps its copy and only asks whether it is still current.
          'Cache-Control': 'no-cache',
          ETag: file.tag,
          ...(file.isolated ? isolation : {}),
          ...(file.policy ? { 'Content-Security-Policy': file.policy } : {}),
          ...(file.type.startsWith('text/html') && file.isolated ? { 'Permissions-Policy': 'camera=(self)' } : {}),
        };
        if (req.headers['if-none-match'] === file.tag) send(req, res, 304, headers);
        else send(req, res, 200, headers, file.body);
        return;
      }
      sendError(req, res, 404, 'There is nothing at this address.');
    } catch (error) {
      log(`request failed: ${error.stack ?? error}`);
      if (!res.headersSent) sendError(req, res, 500, 'The hub ran into a problem handling this request.');
      else res.end();
    }
  };
}

// The hub's HTTP interface.
//
//   GET    /health                                   is the server up (no key needed)
//   GET    /                                         the live results page
//   GET    /api/ping                                 checks an address and key
//   GET    /api/events                               the events the hub holds
//   GET    /api/events/:code/results.json            merged results of an event
//   GET    /api/events/:code/results.csv             the same as a CSV file
//   PUT    /api/events/:code/sources/:device         an iPad sends its results
//   DELETE /api/events/:code                         removes an event from the hub
//
// Everything under /api needs the access key, sent as "Authorization: Bearer
// <key>" or as "?key=<key>" in the address. A separate view key, if one is
// set, can read but not change anything.

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeviceID, isEventCode } from './store.js';
import { isTimeZone, toCSV } from './format.js';

const maxBodyBytes = 8 * 1024 * 1024;

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

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

function send(res, status, headers, body) {
  res.writeHead(status, { ...securityHeaders, ...headers });
  res.end(body);
}

function sendJSON(res, status, value, headers = {}) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(value));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
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
export function createHandler({ store, key, viewKey = '', publicDir, log = () => {} }) {
  const files = new Map();
  for (const [route, [name, type]] of Object.entries(staticFiles)) {
    files.set(route, { body: fs.readFileSync(path.join(publicDir, name)), type });
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

  async function handleAPI(req, res, url) {
    if (!key) {
      sendError(res, 503, 'This hub has no access key yet. Set the HUB_KEY variable on the server and restart it.');
      return;
    }
    const level = accessLevel(req, url);
    if (!level) {
      sendError(res, 401, 'The access key is missing or wrong.');
      return;
    }

    let segments; // segments[0] is "api"
    try {
      segments = url.pathname.split('/').filter((part) => part !== '').map(decodeURIComponent);
    } catch {
      sendError(res, 400, 'The address is not valid.');
      return;
    }

    if (segments.length === 2 && segments[1] === 'ping' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, access: level, store: store.storeID, persistent: store.persistent });
      return;
    }

    if (segments.length === 2 && segments[1] === 'events' && req.method === 'GET') {
      sendJSON(res, 200, { store: store.storeID, events: store.listEvents() });
      return;
    }

    if (segments[1] !== 'events' || segments.length < 3) {
      sendError(res, 404, 'There is nothing at this address.');
      return;
    }
    const code = segments[2];
    if (!isEventCode(code)) {
      sendError(res, 400, 'An event code is 3 to 50 lower-case letters, digits and hyphens.');
      return;
    }

    if (segments.length === 3 && req.method === 'DELETE') {
      if (level !== 'full') return sendError(res, 403, 'This key can only view results.');
      if (!store.deleteEvent(code)) return sendError(res, 404, 'The hub has no event with this code.');
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (segments.length === 5 && segments[3] === 'sources' && req.method === 'PUT') {
      if (level !== 'full') return sendError(res, 403, 'This key can only view results.');
      const device = segments[4];
      if (!isDeviceID(device)) return sendError(res, 400, 'The device identifier is not valid.');
      let push;
      try {
        push = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (error) {
        return sendError(res, error.status ?? 400, error.status ? error.message : 'The upload is not valid JSON.');
      }
      if (push === null || typeof push !== 'object' || Array.isArray(push)) {
        return sendError(res, 400, 'The upload must be a JSON object.');
      }
      const result = store.applyPush(code, device, push);
      if (result.error) return sendError(res, 409, result.error);
      sendJSON(res, 200, result);
      return;
    }

    const isJSON = segments.length === 4 && segments[3] === 'results.json';
    const isCSV = segments.length === 4 && segments[3] === 'results.csv';
    if ((isJSON || isCSV) && req.method === 'GET') {
      // Lets a page that polls skip the download when nothing has changed.
      const tag = `"${store.storeID}:${store.revision(code)}:${createHash('sha256').update(url.search).digest('hex').slice(0, 12)}"`;
      if (store.hasEvent(code) && req.headers['if-none-match'] === tag) {
        send(res, 304, { ETag: tag, 'Cache-Control': 'no-store' });
        return;
      }
      const results = store.results(code, resultsOptions(url));
      if (!results) return sendError(res, 404, 'The hub has no event with this code yet. It appears when an iPad first sends results.');

      if (isJSON) {
        sendJSON(res, 200, { store: store.storeID, now: Date.now(), ...results }, { ETag: tag });
        return;
      }
      const requestedZone = url.searchParams.get('tz');
      const timeZone = isTimeZone(requestedZone) ? requestedZone : isTimeZone(results.timeZone) ? results.timeZone : 'UTC';
      const csv = toCSV(results.rows, {
        format: url.searchParams.get('format') === 'detailed' ? 'detailed' : 'simple',
        timeZone,
        startTime: results.startTime,
      });
      send(res, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${code}.csv"`,
        'Cache-Control': 'no-store',
        ETag: tag,
      }, csv);
      return;
    }

    sendError(res, 404, 'There is nothing at this address.');
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://hub.invalid');
    } catch {
      sendError(res, 400, 'The address is not valid.');
      return;
    }

    try {
      if (url.pathname === '/health') {
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleAPI(req, res, url);
        return;
      }
      const file = files.get(url.pathname);
      if (file && (req.method === 'GET' || req.method === 'HEAD')) {
        send(res, 200, {
          'Content-Type': file.type,
          'Cache-Control': 'no-cache',
          // The page loads nothing from anywhere else and runs no inline script.
          'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        }, req.method === 'HEAD' ? undefined : file.body);
        return;
      }
      sendError(res, 404, 'There is nothing at this address.');
    } catch (error) {
      log(`request failed: ${error.stack ?? error}`);
      if (!res.headersSent) sendError(res, 500, 'The hub ran into a problem handling this request.');
      else res.end();
    }
  };
}

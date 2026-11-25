import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { startHub } from '../server.js';

const key = 'correct-horse-battery';
const viewKey = 'look-but-do-not-touch';
const device = 'AAAAAAAA-0000-4000-8000-000000000001';
const start = 1_609_459_200; // 2021-01-01T00:00:00Z

let hub;
let base;

before(async () => {
  hub = await startHub({ host: '127.0.0.1', key, viewKey });
  base = `http://127.0.0.1:${hub.port}`;
});

after(async () => {
  await hub.close();
});

function call(path, { method = 'GET', as = key, body, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(as ? { Authorization: `Bearer ${as}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function upload(crossings, extra = {}) {
  return { station: 'Finish', raceName: 'New Year Dash', timeZone: 'UTC', startTime: start, full: true, crossings, deleted: [], ...extra };
}

function crossing(id, bib, seconds, extra = {}) {
  return { id, bib, time: start + seconds, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.012, confidence: 1, note: '', ...extra };
}

test('health needs no key', async () => {
  const response = await call('/health', { as: null });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('the API needs a key, in a header or in the address', async () => {
  assert.equal((await call('/api/ping', { as: null })).status, 401);
  assert.equal((await call('/api/ping', { as: 'wrong-key-entirely' })).status, 401);

  const withHeader = await call('/api/ping');
  assert.equal(withHeader.status, 200);
  assert.equal((await withHeader.json()).access, 'full');

  const inAddress = await call(`/api/ping?key=${key}`, { as: null });
  assert.equal(inAddress.status, 200);

  const viewing = await call('/api/ping', { as: viewKey });
  assert.equal((await viewing.json()).access, 'view');
});

test('an iPad uploads results and the scoring computer reads them', async () => {
  const first = await call(`/api/events/new-year-dash/sources/${device}`, {
    method: 'PUT',
    body: upload([crossing('c2', '12', 1500.25), crossing('c1', '7', 1432.5)]),
  });
  assert.equal(first.status, 200);
  const reply = await first.json();
  assert.equal(reply.count, 2);
  assert.equal(reply.store, hub.store.storeID);

  const list = await (await call('/api/events', { as: viewKey })).json();
  assert.deepEqual(list.events.map((event) => [event.code, event.name, event.count]), [['new-year-dash', 'New Year Dash', 2]]);

  const json = await call('/api/events/new-year-dash/results.json', { as: viewKey });
  assert.equal(json.status, 200);
  const results = await json.json();
  assert.deepEqual(results.rows.map((row) => [row.bib, row.station]), [['7', 'Finish'], ['12', 'Finish']]);
  assert.equal(results.startTime, start);
  assert.equal(typeof results.now, 'number');

  const csv = await call(`/api/events/new-year-dash/results.csv?key=${viewKey}`, { as: null });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.equal(await csv.text(), 'bib,time_of_day,elapsed,station\r\n7,00:23:52.500,0:23:52.500,Finish\r\n12,00:25:00.250,0:25:00.250,Finish\r\n');

  const detailed = await (await call('/api/events/new-year-dash/results.csv?format=detailed&tz=America/New_York')).text();
  assert.equal(detailed.split('\r\n')[1], '1,7,19:23:52.500,0:23:52.500,2021-01-01T00:23:52.500Z,line,camera,1.00,ntp,12,Finish,');
});

test('a later upload can change and remove results', async () => {
  await call(`/api/events/edits/sources/${device}`, { method: 'PUT', body: upload([crossing('a', '1', 10), crossing('b', '2', 20)]) });
  const partial = await call(`/api/events/edits/sources/${device}`, {
    method: 'PUT',
    body: upload([crossing('a', '11', 10)], { full: false, deleted: ['b'] }),
  });
  assert.equal((await partial.json()).count, 1);
  const rows = (await (await call('/api/events/edits/results.json')).json()).rows;
  assert.deepEqual(rows.map((row) => [row.id, row.bib]), [['a', '11']]);
});

test('unchanged results are not sent again', async () => {
  await call(`/api/events/polling/sources/${device}`, { method: 'PUT', body: upload([crossing('a', '1', 10)]) });
  const first = await call('/api/events/polling/results.json');
  const tag = first.headers.get('etag');
  assert.ok(tag);
  await first.arrayBuffer();

  const again = await call('/api/events/polling/results.json', { headers: { 'If-None-Match': tag } });
  assert.equal(again.status, 304);

  await call(`/api/events/polling/sources/${device}`, { method: 'PUT', body: upload([crossing('b', '2', 20)], { full: false }) });
  const changed = await call('/api/events/polling/results.json', { headers: { 'If-None-Match': tag } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).rows.length, 2);
});

test('the live page is sent only what has changed', async () => {
  const address = `/api/events/live-feed/sources/${device}`;
  await call(address, { method: 'PUT', body: upload([crossing('a', '1', 10), crossing('b', '2', 20)]) });

  // First look: everything.
  const first = await call('/api/events/live-feed/live', { as: viewKey });
  assert.equal(first.status, 200);
  const everything = await first.json();
  assert.equal(everything.full, true);
  assert.equal(everything.revision, 1);
  assert.deepEqual(everything.rows.map((row) => row.id), ['a', 'b']);
  assert.equal(everything.stations[0].station, 'Finish');
  assert.equal(everything.startTime, start);

  // Asking again with what is already held costs next to nothing.
  const held = `?store=${everything.store}&since=${everything.revision}`;
  const caughtUp = await call(`/api/events/live-feed/live${held}`);
  const nothingNew = await caughtUp.json();
  assert.equal(nothingNew.full, false);
  assert.deepEqual(nothingNew.rows, []);
  assert.deepEqual(nothingNew.removed, []);
  const tag = caughtUp.headers.get('etag');
  const unchanged = await call(`/api/events/live-feed/live${held}`, { headers: { 'If-None-Match': tag } });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

  // One result arrives and one is deleted: only that travels.
  await call(address, { method: 'PUT', body: upload([crossing('c', '3', 30)], { full: false, deleted: ['a'] }) });
  const changed = await call(`/api/events/live-feed/live${held}`, { headers: { 'If-None-Match': tag } });
  assert.equal(changed.status, 200);
  const difference = await changed.json();
  assert.equal(difference.full, false);
  assert.equal(difference.revision, 2);
  assert.deepEqual(difference.rows.map((row) => row.id), ['c']);
  assert.deepEqual(difference.removed, ['a']);

  // A reader that last saw other data (the hub lost its own since) gets everything.
  const stranger = await (await call('/api/events/live-feed/live?store=some-other-store&since=1')).json();
  assert.equal(stranger.full, true);
  assert.deepEqual(stranger.rows.map((row) => row.id), ['b', 'c']);

  assert.equal((await call('/api/events/never-heard-of-it/live')).status, 404);
});

test('an iPad checking in changes the version of the live feed but not of the results', async () => {
  const address = `/api/events/check-in/sources/${device}`;
  await call(address, { method: 'PUT', body: upload([crossing('a', '1', 10)]) });
  const results = await call('/api/events/check-in/results.json');
  const resultsTag = results.headers.get('etag');
  await results.arrayBuffer();
  const live = await call('/api/events/check-in/live');
  const liveBody = await live.json();
  const held = `?store=${liveBody.store}&since=${liveBody.revision}`;
  const liveTag = (await call(`/api/events/check-in/live${held}`)).headers.get('etag');

  // A moment later the iPad checks in with nothing new.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(address, { method: 'PUT', body: upload([], { full: false }) });

  assert.equal((await call('/api/events/check-in/results.json', { headers: { 'If-None-Match': resultsTag } })).status, 304);
  const afterCheckIn = await call(`/api/events/check-in/live${held}`, { headers: { 'If-None-Match': liveTag } });
  assert.equal(afterCheckIn.status, 200);
  const body = await afterCheckIn.json();
  assert.deepEqual(body.rows, []);
  assert.ok(body.stations[0].updatedAt >= liveBody.stations[0].updatedAt);
});

function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('large replies are compressed for readers that can take it', async () => {
  const many = Array.from({ length: 300 }, (_, index) => crossing(`c${index}`, String(100 + index), index));
  await call(`/api/events/big-field/sources/${device}`, { method: 'PUT', body: upload(many) });

  const plain = await rawGet('/api/events/big-field/results.json', {});
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body).rows.length, 300);

  const packed = await rawGet('/api/events/big-field/results.json', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.equal(packed.headers.vary, 'Accept-Encoding');
  assert.equal(Number(packed.headers['content-length']), packed.body.length);
  assert.equal(JSON.parse(gunzipSync(packed.body)).rows.length, 300);
  assert.ok(packed.body.length < plain.body.length / 3, `${packed.body.length} of ${plain.body.length} bytes`);

  // Small replies are left alone.
  const small = await rawGet('/api/ping', { 'Accept-Encoding': 'gzip' });
  assert.equal(small.headers['content-encoding'], undefined);
});

test('the view key cannot change anything', async () => {
  const response = await call(`/api/events/protected/sources/${device}`, { method: 'PUT', as: viewKey, body: upload([crossing('a', '1', 10)]) });
  assert.equal(response.status, 403);
  assert.equal((await call('/api/events/protected/results.json')).status, 404);
  assert.equal((await call('/api/events/new-year-dash', { method: 'DELETE', as: viewKey })).status, 403);
});

test('bad requests are refused politely', async () => {
  assert.equal((await call(`/api/events/NOT_A_CODE/sources/${device}`, { method: 'PUT', body: upload([]) })).status, 400);
  assert.equal((await call('/api/events/some-race/sources/x', { method: 'PUT', body: upload([]) })).status, 400);
  assert.equal((await call(`/api/events/some-race/sources/${device}`, { method: 'PUT', body: '{not json' })).status, 400);
  assert.equal((await call(`/api/events/some-race/sources/${device}`, { method: 'PUT', body: '[1, 2]' })).status, 400);
  assert.equal((await call('/api/events/never-heard-of-it/results.csv')).status, 404);
  assert.equal((await call('/api/nonsense')).status, 404);
  assert.equal((await call('/api/events/%E0%A4%A/results.json')).status, 400);
  assert.equal((await call('/somewhere-else', { as: null })).status, 404);

  // Nonsense inside an upload is dropped, the rest is kept.
  const mixed = await call(`/api/events/some-race/sources/${device}`, {
    method: 'PUT',
    body: upload([crossing('ok', '5', 1), { id: 'no-time', bib: '6' }, 'garbage', null]),
  });
  assert.equal((await mixed.json()).count, 1);
});

test('an event can be removed', async () => {
  await call(`/api/events/short-lived/sources/${device}`, { method: 'PUT', body: upload([crossing('a', '1', 10)]) });
  assert.equal((await call('/api/events/short-lived', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/events/short-lived/results.json')).status, 404);
  assert.equal((await call('/api/events/short-lived', { method: 'DELETE' })).status, 404);
});

test('the results page is served, locked down', async () => {
  const page = await call('/', { as: null });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /Bib Timer results/);
  assert.equal((await call('/app.js', { as: null })).status, 200);
  assert.equal((await call('/app.css', { as: null })).status, 200);
});

test('a hub without a usable key refuses to serve results', async () => {
  for (const badKey of ['', 'short']) {
    const messages = [];
    const locked = await startHub({ host: '127.0.0.1', key: badKey, log: (message) => messages.push(message) });
    try {
      const response = await fetch(`http://127.0.0.1:${locked.port}/api/ping?key=${badKey}`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /HUB_KEY/);
      assert.equal((await fetch(`http://127.0.0.1:${locked.port}/health`)).status, 200);
      assert.equal(messages.length, 1);
    } finally {
      await locked.close();
    }
  }
});

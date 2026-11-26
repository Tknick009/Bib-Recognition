// How the hub serves the capture page: the page's own files, the large
// files it reads numbers with, the list of what an iPad is to keep a copy
// of, and the clock the iPads set theirs by.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHandler } from '../lib/app.js';
import { HubClock } from '../lib/ntp.js';
import { Store } from '../lib/store.js';
import { startHub } from '../server.js';

const key = 'correct-horse-battery';
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// The reader's files are fetched by "npm ci"; without them the hub still
// runs, and these tests have less to look at.
const hasReader = fs.existsSync(path.join(publicDir, 'vendor', 'detection.onnx'));
const readerNeeded = process.env.BIBTIMER_READER_REQUIRED === '1';
const withoutReader = hasReader ? false : 'the reader\'s files are not installed (run "npm ci" in the hub folder)';

let hub;
let base;
const logged = [];

before(async () => {
  hub = await startHub({ host: '127.0.0.1', key, log: (line) => logged.push(line) });
  base = `http://127.0.0.1:${hub.port}`;
});

after(async () => {
  await hub.close();
});

/** A request whose answer is left exactly as the hub sent it, still packed. */
function raw(address, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

function filesBelow(folder, prefix = '') {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? filesBelow(path.join(folder, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

test('where the reader\'s files are required, they are there', { skip: !readerNeeded }, () => {
  assert.ok(hasReader, 'public/vendor is missing: "npm ci" in the hub folder puts it there');
});

test('the capture page is served to anyone, with what the camera and the reader need', async () => {
  const page = await raw(`${base}/capture/`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body.toString(), /<title>Bib Timer camera<\/title>/);
  // Several processor cores at once are only given to a page that is shut off from others.
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
  // The reader is a WebAssembly program run in workers; nothing comes from anywhere else.
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval' blob:;/);
  assert.match(page.headers['content-security-policy'], /worker-src 'self' blob:/);
  assert.equal(page.headers['permissions-policy'], 'camera=(self)');
  assert.equal(page.headers['cache-control'], 'no-cache');

  const again = await raw(`${base}/capture/`, { headers: { 'If-None-Match': page.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  // Without the slash at the end the page's own files would not be found next to it.
  const bare = await raw(`${base}/capture`);
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, '/capture/');
});

test('every file of the capture page has an address, and scripts are sent as scripts', async () => {
  const names = filesBelow(path.join(publicDir, 'capture'));
  assert.ok(names.includes('capture.js') && names.includes('lib/tracker.js') && names.includes('ocr-worker.js'));
  for (const name of names) {
    const response = await raw(`${base}/capture/${name === 'index.html' ? '' : name}`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200, name);
    if (name.endsWith('.js')) assert.match(response.headers['content-type'], /^text\/javascript/, name);
    // A worker is only started in a page shut off from others if it says it belongs there.
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp', name);
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin', name);
    if (name !== 'sw.js') {
      const body = response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;
      assert.ok(body.equals(fs.readFileSync(path.join(publicDir, 'capture', name))), `${name} arrives as it is on disk`);
    }
  }
  assert.equal((await raw(`${base}/capture/no-such-file.js`)).status, 404);
  assert.equal((await raw(`${base}/capture/../server.js`)).status, 404);
});

test('the page loads nothing that is not listed for keeping on the iPad', () => {
  // Whatever the page needs must be in its own folder (or among the reader's
  // files), or it would not open without a connection.
  const html = fs.readFileSync(path.join(publicDir, 'capture', 'index.html'), 'utf8');
  const loaded = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((address) => !address.startsWith('#'));
  // The link to the results page is the one thing that leads elsewhere; the
  // reader's files (among them the notice of whose work they are) are kept too.
  assert.deepEqual(loaded.filter((address) => (address.startsWith('/') && !address.startsWith('/vendor/')) || address.includes('//')), ['/']);
  for (const name of filesBelow(path.join(publicDir, 'capture')).filter((file) => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(publicDir, 'capture', name), 'utf8');
    const addresses = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\)/g),
    ].map((match) => match[1]);
    for (const address of addresses) {
      assert.ok(address.startsWith('./') || address.startsWith('../') || address.startsWith('/vendor/'), `${name} loads ${address}`);
    }
  }
});

test('the list of what an iPad keeps is filled in, in two groups with a version each', async () => {
  const worker = await raw(`${base}/capture/sw.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /^text\/javascript/);
  const source = worker.body.toString();
  assert.ok(!source.includes('__GROUPS__'));
  const groups = JSON.parse(/^const groups = (\[.*\]);$/m.exec(source)[1]);
  assert.deepEqual(groups.map((group) => [group.name, group.eager]), [['page', true], ['reader', false]]);
  for (const group of groups) assert.match(group.version, /^[0-9a-f]{12}$/);

  const [page, reader] = groups;
  const expected = filesBelow(path.join(publicDir, 'capture')).filter((name) => name !== 'sw.js')
    .map((name) => (name === 'index.html' ? '/capture/' : `/capture/${name}`)).sort();
  assert.deepEqual([...page.files].sort(), expected);
  for (const file of [...page.files, ...reader.files]) {
    assert.equal((await raw(`${base}${file}`, { method: 'HEAD' })).status, 200, file);
  }
  if (hasReader) {
    for (const file of ['/vendor/detection.onnx', '/vendor/recognition.onnx', '/vendor/characters.txt', '/vendor/ort.wasm.min.mjs',
      '/vendor/ort-wasm-simd-threaded.mjs', '/vendor/ort-wasm-simd-threaded.wasm', '/vendor/plain/ort.wasm.min.js', '/vendor/plain/ort-wasm-simd.wasm']) {
      assert.ok(reader.files.includes(file), file);
    }
    // The packed copies are ways of sending a file, not files of their own.
    assert.ok(reader.files.every((file) => !file.endsWith('.br') && !file.endsWith('.gz')));
  } else {
    assert.deepEqual(reader.files, []);
  }
});

test('the versions change with the files, each group by itself', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bibtimer-public-'));
  try {
    fs.cpSync(publicDir, folder, { recursive: true, filter: (source) => !source.includes(`${path.sep}vendor`) });
    fs.mkdirSync(path.join(folder, 'vendor'));
    fs.writeFileSync(path.join(folder, 'vendor', 'characters.txt'), 'a\nb\n');
    const groupsOf = () => {
      const handler = createHandler({ store: new Store(), key, publicDir: folder });
      let body = null;
      handler({ url: '/capture/sw.js', method: 'GET', headers: {} }, { writeHead() {}, end(sent) { body = sent; } });
      return JSON.parse(/^const groups = (\[.*\]);$/m.exec(body.toString())[1]);
    };
    const first = groupsOf();
    fs.appendFileSync(path.join(folder, 'capture', 'capture.css'), '\n/* changed */\n');
    const second = groupsOf();
    assert.notEqual(second[0].version, first[0].version, 'a change to the page gives the page a new version');
    assert.equal(second[1].version, first[1].version, 'and leaves the reader\'s files alone, so they are not fetched again');
    fs.writeFileSync(path.join(folder, 'vendor', 'characters.txt'), 'a\nb\nc\n');
    const third = groupsOf();
    assert.equal(third[0].version, second[0].version);
    assert.notEqual(third[1].version, second[1].version);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the reader\'s large files are sent packed, and not again when the iPad has them', { skip: withoutReader }, async () => {
  const file = path.join(publicDir, 'vendor', 'detection.onnx');
  const original = fs.readFileSync(file);
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

  const packed = await raw(`${base}/vendor/detection.onnx`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers['content-encoding'], 'br');
  assert.equal(Number(packed.headers['content-length']), fs.statSync(`${file}.br`).size);
  assert.equal(digest(brotliDecompressSync(packed.body)), digest(original));
  assert.equal(packed.headers.vary, 'Accept-Encoding');
  assert.equal(packed.headers['cross-origin-resource-policy'], 'same-origin');

  const zipped = await raw(`${base}/vendor/detection.onnx`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(digest(gunzipSync(zipped.body)), digest(original));

  const plain = await raw(`${base}/vendor/detection.onnx`);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(digest(plain.body), digest(original));
  // One version tag per way of sending, so that a copy is never taken for another.
  assert.equal(new Set([packed.headers.etag, zipped.headers.etag, plain.headers.etag]).size, 3);

  const unchanged = await raw(`${base}/vendor/detection.onnx`, { headers: { 'Accept-Encoding': 'br', 'If-None-Match': packed.headers.etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  const head = await raw(`${base}/vendor/detection.onnx`, { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const program = await raw(`${base}/vendor/plain/ort-wasm-simd.wasm`, { method: 'HEAD' });
  assert.equal(program.headers['content-type'], 'application/wasm');
  assert.equal((await raw(`${base}/vendor/detection.onnx.br`)).status, 404);
});

test('the quick reader asks the browser for 1 GB of shared memory, not 4', { skip: withoutReader }, () => {
  // Safari on iPads has been reported to refuse the larger amount.
  const glue = fs.readFileSync(path.join(publicDir, 'vendor', 'ort-wasm-simd-threaded.mjs'), 'utf8');
  assert.ok(glue.includes('WebAssembly.Memory({initial:256,maximum:16384,shared:!0})'));
  assert.ok(!glue.includes('maximum:65536'));
});

test('the hub says whether its capture page can read bibs', async () => {
  const ping = await (await fetch(`${base}/api/ping`, { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.equal(ping.capture, hasReader);

  // A hub that was put on a server without the reader's files still collects and shows results.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bibtimer-public-'));
  const lines = [];
  let bare;
  try {
    fs.cpSync(publicDir, folder, { recursive: true, filter: (source) => !source.includes(`${path.sep}vendor`) });
    bare = await startHub({ host: '127.0.0.1', key, publicDir: folder, log: (line) => lines.push(line) });
    const address = `http://127.0.0.1:${bare.port}`;
    assert.equal((await (await fetch(`${address}/api/ping`, { headers: { Authorization: `Bearer ${key}` } })).json()).capture, false);
    assert.ok(lines.some((line) => /cannot read bibs/.test(line)), 'and says so where whoever runs it will see');
    assert.equal((await raw(`${address}/capture/`)).status, 200);
    assert.equal((await raw(`${address}/`)).status, 200);
    assert.equal((await raw(`${address}/vendor/detection.onnx`)).status, 404);
  } finally {
    await bare?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the clock the iPads set theirs by needs the key and gives two moments', async () => {
  assert.equal((await fetch(`${base}/api/time`)).status, 401);
  const before = Date.now();
  const response = await fetch(`${base}/api/time?n=1`, { headers: { Authorization: `Bearer ${key}` } });
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.ok(body.received >= before && body.sent >= body.received && body.sent <= after, JSON.stringify({ before, body, after }));
  // This hub was given no time servers to check its own clock against.
  assert.deepEqual([body.error, body.checked], [null, false]);
});

test('a hub that has checked its clock against time servers gives the corrected time', async () => {
  // This computer's clock is taken to be 5 s behind, to within 12 ms.
  const clock = new HubClock({ servers: ['a.test', 'b.test'], ask: async () => ({ offset: 5000, delay: 20, error: 12 }) });
  assert.equal(await clock.check(), true);
  const server = http.createServer(createHandler({ store: new Store(), key, publicDir, clock }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const before = Date.now();
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/time`, { headers: { Authorization: `Bearer ${key}` } })).json();
    const after = Date.now();
    assert.ok(body.received >= before + 5000 && body.sent <= after + 5000, JSON.stringify({ before, body, after }));
    assert.equal(body.checked, true);
    assert.ok(body.error >= 12 && body.error < 13, `how far off it may be is passed on (${body.error})`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

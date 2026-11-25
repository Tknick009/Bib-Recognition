// The live results page. Asks the hub every couple of seconds what has changed
// and redraws the table when something has. Only changes are downloaded, never
// the whole table again, so the page is cheap to leave open on a metered
// connection. All text from the iPads is inserted as text, never as HTML.

const keyStorage = 'bibtimer.hub.key';
// How often to ask the hub for news: briskly while results are coming in,
// less often once it has gone quiet, because every question costs data.
const pollWhenBusy = 2000;
const pollWhenQuiet = 5000;
const busyFor = 30_000;
const eventsEvery = 15_000; // how often to look for new events
const quietAfter = 150_000; // an iPad checks in every 45 seconds; this long without is worth noticing

const $ = (id) => document.getElementById(id);

const state = {
  key: null,
  events: [],
  eventsLoadedAt: 0,
  code: null,
  // What is held for the current event: which hub data it came from, how
  // far it is up to date, and the version tag of the last reply.
  store: null,
  revision: null,
  tag: null,
  info: null,
  rows: new Map(),
  // Server clock at the last full reply, and when (on this computer) it arrived.
  serverNow: 0,
  receivedAt: 0,
  hiddenDevices: new Set(),
  seen: null,
  lastSuccess: 0,
  // When a result last arrived, changed or was removed.
  lastChange: 0,
  timer: null,
};

// ---- Talking to the hub ----

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${state.key}`, ...(options.headers ?? {}) },
    cache: 'no-store',
  });
  if (response.status === 401) {
    signOut('That key was not accepted.');
    throw new Error('unauthorized');
  }
  return response;
}

async function errorMessage(response) {
  try {
    return (await response.json()).error ?? `The hub answered ${response.status}.`;
  } catch {
    return `The hub answered ${response.status}.`;
  }
}

function resultsQuery({ format } = {}) {
  const query = new URLSearchParams();
  if (format) query.set('format', format);
  if (state.hiddenDevices.size > 0 && state.info) {
    const shown = state.info.stations.filter((station) => !state.hiddenDevices.has(station.device));
    query.set('devices', shown.map((station) => station.device).join(','));
  }
  if ($('first-only').checked) query.set('dedupe', 'first');
  const text = query.toString();
  return text ? `?${text}` : '';
}

// ---- Signing in and out ----

function signOut(problem) {
  pollLoop += 1;
  clearTimeout(state.timer);
  state.key = null;
  forgetEvent();
  try {
    localStorage.removeItem(keyStorage);
  } catch {
    // Private browsing: nothing was stored.
  }
  $('board').hidden = true;
  $('waiting').hidden = true;
  $('status').hidden = true;
  $('sign-out').hidden = true;
  $('sign-in').hidden = false;
  $('key-problem').hidden = !problem;
  $('key-problem').textContent = problem ?? '';
  $('key-input').value = '';
  $('key-input').focus();
}

async function signIn(key) {
  state.key = key;
  let response;
  try {
    response = await request('/api/ping');
  } catch (error) {
    if (error.message !== 'unauthorized') signOut('The hub could not be reached. Check the connection and try again.');
    return;
  }
  if (!response.ok) {
    signOut(await errorMessage(response));
    return;
  }
  try {
    localStorage.setItem(keyStorage, key);
  } catch {
    // Private browsing: the key will have to be entered again next time.
  }
  $('sign-in').hidden = true;
  $('sign-out').hidden = false;
  $('status').hidden = false;
  state.eventsLoadedAt = 0;
  poll();
}

// ---- Polling ----

// Each call starts a new polling loop and retires the previous one, so
// changing event or key mid-request can never leave two loops running.
let pollLoop = 0;

async function poll() {
  const loop = ++pollLoop;
  clearTimeout(state.timer);
  try {
    await refresh();
    state.lastSuccess = Date.now();
  } catch (error) {
    if (error.message === 'unauthorized') return;
  }
  if (loop !== pollLoop) return;
  drawStatus();
  const delay = Date.now() - state.lastChange < busyFor ? pollWhenBusy : pollWhenQuiet;
  if (state.key) state.timer = setTimeout(poll, delay);
}

async function refresh() {
  if (!state.code || Date.now() - state.eventsLoadedAt > eventsEvery) {
    await loadEvents();
  }
  if (!state.code) return;

  const code = state.code;
  const query = new URLSearchParams();
  if (state.store !== null && state.revision !== null) {
    query.set('store', state.store);
    query.set('since', String(state.revision));
  }
  const response = await request(`/api/events/${encodeURIComponent(code)}/live?${query}`, {
    headers: state.tag ? { 'If-None-Match': state.tag } : {},
  });
  // The event shown may have been switched while the request was under way.
  if (code !== state.code) return;
  if (response.status === 304) return;
  if (response.status === 404) {
    // Removed from the hub meanwhile: look at what is there now.
    state.code = null;
    state.eventsLoadedAt = 0;
    return;
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json();
  if (code !== state.code) return;
  state.tag = response.headers.get('ETag');
  takeIn(body);
}

async function loadEvents() {
  const response = await request('/api/events');
  if (!response.ok) throw new Error(await errorMessage(response));
  state.events = (await response.json()).events;
  state.eventsLoadedAt = Date.now();

  if (state.events.length === 0) {
    forgetEvent();
    $('board').hidden = true;
    $('waiting').hidden = false;
    return;
  }
  if (!state.events.some((event) => event.code === state.code)) {
    selectEvent(state.events[0].code);
  }
  drawEventList();
  $('waiting').hidden = true;
  $('board').hidden = false;
}

/** Merges a reply from the hub into what is held, then redraws. */
function takeIn(body) {
  if (body.full || body.store !== state.store) {
    state.rows = new Map();
  }
  for (const row of body.rows) state.rows.set(row.id, row);
  for (const id of body.removed) state.rows.delete(id);
  if (body.rows.length > 0 || body.removed.length > 0) state.lastChange = Date.now();
  state.store = body.store;
  state.revision = body.revision;
  state.info = {
    startTime: body.startTime,
    startFrom: body.startFrom,
    timeZone: body.timeZone,
    stations: body.stations,
  };
  state.serverNow = body.now;
  state.receivedAt = Date.now();
  draw();
}

function forgetEvent() {
  state.code = null;
  state.store = null;
  state.revision = null;
  state.tag = null;
  state.info = null;
  state.rows = new Map();
  state.seen = null;
  state.hiddenDevices.clear();
  delete $('stations').dataset.shape;
  $('note').hidden = true;
}

function selectEvent(code) {
  forgetEvent();
  state.code = code;
  state.lastChange = Date.now();
}

// ---- Drawing ----

function timeOfDay(seconds, timeZone) {
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  return `${formatter.format(new Date(whole * 1000))}.${String(ms - whole * 1000).padStart(3, '0')}`;
}

function elapsed(startSeconds, endSeconds) {
  const total = Math.round(endSeconds * 1000) - Math.round(startSeconds * 1000);
  const magnitude = Math.abs(total);
  const two = (value) => String(value).padStart(2, '0');
  return `${total < 0 ? '-' : ''}${Math.floor(magnitude / 3_600_000)}:${two(Math.floor(magnitude / 60_000) % 60)}:` +
    `${two(Math.floor(magnitude / 1000) % 60)}.${String(magnitude % 1000).padStart(3, '0')}`;
}

function age(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawStatus() {
  const status = $('status');
  const silentFor = Date.now() - state.lastSuccess;
  if (state.lastSuccess === 0 || silentFor > 30_000) {
    status.className = 'status down';
    status.textContent = 'Not connected';
  } else if (silentFor > 13_000) {
    status.className = 'status stale';
    status.textContent = 'Reconnecting';
  } else {
    status.className = 'status live';
    status.textContent = 'Live';
  }
}

function drawEventList() {
  const select = $('event-select');
  const wanted = state.events.map((event) => `${event.code}\u0000${event.name}`).join('\u0001');
  if (select.dataset.shown !== wanted) {
    select.replaceChildren(...state.events.map((event) => {
      const option = element('option', null, event.name === event.code ? event.code : `${event.name} (${event.code})`);
      option.value = event.code;
      return option;
    }));
    select.dataset.shown = wanted;
  }
  select.value = state.code;
}

function drawStations() {
  const info = state.info;
  if (!info) return;
  const container = $('stations');
  // The chips are only rebuilt when the stations themselves change, so a
  // checkbox is never replaced while someone is clicking it.
  const shape = info.stations.map((station) => `${station.device}\u0000${station.station}`).join('\u0001');
  if (container.dataset.shape !== shape) {
    container.replaceChildren(...info.stations.map((station) => {
      const chip = element('label', 'station');
      chip.dataset.device = station.device;
      const box = element('input');
      box.type = 'checkbox';
      box.checked = !state.hiddenDevices.has(station.device);
      box.addEventListener('change', () => {
        if (box.checked) state.hiddenDevices.delete(station.device);
        else state.hiddenDevices.add(station.device);
        draw();
      });
      chip.append(box, element('span', null, station.station), element('span', 'count'), element('span', 'age'));
      return chip;
    }));
    container.dataset.shape = shape;
  }

  const serverNow = state.serverNow + (Date.now() - state.receivedAt);
  for (const chip of container.children) {
    const station = info.stations.find((item) => item.device === chip.dataset.device);
    if (!station) continue;
    const silent = serverNow - station.updatedAt;
    chip.classList.toggle('quiet-for-long', silent > quietAfter);
    chip.querySelector('.count').textContent = String(station.count);
    chip.querySelector('.age').textContent = `heard ${age(silent)}`;
  }
}

/** The rows to show, in finishing order. */
function visibleRows() {
  let rows = [...state.rows.values()]
    .filter((row) => !state.hiddenDevices.has(row.device))
    .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if ($('first-only').checked) {
    const bibs = new Set();
    rows = rows.filter((row) => {
      if (row.bib === '') return true;
      if (bibs.has(row.bib)) return false;
      bibs.add(row.bib);
      return true;
    });
  }
  return rows;
}

function draw() {
  const info = state.info;
  if (!info) return;
  drawStations();

  const rows = visibleRows();
  $('total').textContent = String(rows.length);
  $('start').textContent = info.startTime == null
    ? 'not set'
    : `${timeOfDay(info.startTime, info.timeZone).slice(0, -2)}${info.startFrom ? ` (from ${info.startFrom})` : ''}`;

  // Rows that were not there at the previous draw are highlighted briefly.
  const previouslySeen = state.seen;
  state.seen = new Set(state.rows.keys());

  const numbered = rows.map((row, index) => ({ row, position: index + 1 }));
  if ($('newest-first').checked) numbered.reverse();

  $('rows').replaceChildren(...numbered.map(({ row, position }) => {
    const line = element('tr', previouslySeen && !previouslySeen.has(row.id) ? 'fresh' : null);
    line.append(
      element('td', 'num', String(position)),
      element('td', row.bib === '' ? 'bib missing' : 'bib', row.bib === '' ? '?' : row.bib),
      element('td', null, timeOfDay(row.time, info.timeZone)),
      element('td', null, info.startTime == null ? '' : elapsed(info.startTime, row.time)),
      element('td', null, row.station),
    );
    const notes = element('td', 'notes');
    if (row.source === 'manual') notes.append(element('span', 'tag', 'by hand'));
    if (row.timing === 'estimated') notes.append(element('span', 'tag', 'estimated'));
    if (row.clock === 'device') notes.append(element('span', 'tag warn', 'iPad clock'));
    if (row.note) notes.append(document.createTextNode(row.note));
    line.append(notes);
    return line;
  }));
  $('empty').hidden = rows.length > 0;
}

// ---- Downloads ----

async function download(format) {
  const response = await request(`/api/events/${encodeURIComponent(state.code)}/results.csv${resultsQuery({ format })}`);
  if (!response.ok) {
    showNote(await errorMessage(response));
    return;
  }
  const link = element('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = `${state.code}${format === 'detailed' ? '-details' : ''}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

function showNote(text) {
  $('note').textContent = text;
  $('note').hidden = false;
}

async function copyLink() {
  const query = new URLSearchParams(resultsQuery().slice(1));
  query.set('key', state.key);
  const link = `${location.origin}/api/events/${encodeURIComponent(state.code)}/results.csv?${query}`;
  try {
    await navigator.clipboard.writeText(link);
    showNote('Link copied. Anything that opens it gets the current results as CSV. It contains the access key, so treat it like a password.');
  } catch {
    showNote(`Copy this link (it contains the access key): ${link}`);
  }
}

async function removeEvent() {
  const code = state.code;
  if (!code) return;
  const sure = confirm(
    `Remove "${code}" and its results from this site?\n\n` +
    'The iPads keep their own copies. If an iPad still has this race open, it will send its results here again.',
  );
  if (!sure) return;
  const response = await request(`/api/events/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (!response.ok) {
    showNote(await errorMessage(response));
    return;
  }
  forgetEvent();
  state.eventsLoadedAt = 0;
  poll();
}

// ---- Start ----

$('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('key-input').value.trim();
  if (key) signIn(key);
});
$('sign-out').addEventListener('click', () => signOut());
$('event-select').addEventListener('change', (event) => {
  selectEvent(event.target.value);
  poll();
});
$('first-only').addEventListener('change', draw);
$('newest-first').addEventListener('change', draw);
$('download-simple').addEventListener('click', () => download('simple'));
$('download-detailed').addEventListener('click', () => download('detailed'));
$('copy-link').addEventListener('click', copyLink);
$('remove-event').addEventListener('click', removeEvent);
setInterval(() => {
  if (state.key) {
    drawStatus();
    drawStations();
  }
}, 1000);

// A key can be handed over in the address, after "#key=". That part of an
// address is never sent to a server, and it is removed from view at once.
function keyFromAddress() {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (key) history.replaceState(null, '', location.pathname);
  return key;
}

// Opening such a link in a tab that already shows this page only changes the
// address, without loading the page again.
window.addEventListener('hashchange', () => {
  const key = keyFromAddress();
  if (key) signIn(key);
});

const fromAddress = keyFromAddress();
let storedKey = null;
try {
  storedKey = localStorage.getItem(keyStorage);
} catch {
  // Private browsing.
}
if (fromAddress || storedKey) signIn(fromAddress || storedKey);
else signOut();

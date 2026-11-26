// Keeps a copy of the capture page, and of what it reads numbers with, on
// the iPad. With it the page opens at once, and also when there is no
// connection at the finish line (Safari may reload a page it has put away):
// results are then kept on the iPad and sent when the connection is back.
//
// The hub fills in the value below when it sends this file. There are two
// groups of files, each with a version that changes when any file in it does:
// the page's own files, which are small and fetched as soon as this is
// installed, and the files numbers are read with, which are large and kept
// as they are first used. A new version of the page therefore does not make
// an iPad download the large files again.

const groups = '__GROUPS__';

const cacheName = (group) => `bibtimer-${group.name}-${group.version}`;
const groupOf = new Map();
for (const group of groups) {
  for (const file of group.files) groupOf.set(file, group);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    for (const group of groups) {
      if (!group.eager) continue;
      const cache = await caches.open(cacheName(group));
      // Asked of the hub afresh, not taken from whatever the browser holds.
      await cache.addAll(group.files.map((url) => new Request(url, { cache: 'no-cache' })));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = new Set(groups.map(cacheName));
    for (const name of await caches.keys()) {
      if (name.startsWith('bibtimer-') && !current.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Only the page's own files are answered from the copy. Everything else
  // (results, the clock) is the hub's to answer.
  const group = groupOf.get(url.pathname);
  if (!group) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName(group));
    const kept = await cache.match(url.pathname, { ignoreVary: true });
    if (kept) return kept;
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(cache.put(url.pathname, copy).catch(() => {
        // Cut short, or no room: it is fetched again next time.
      }));
    }
    return response;
  })());
});

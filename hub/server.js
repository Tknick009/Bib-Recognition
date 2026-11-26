// Bib Timer hub: collects results from the iPads and serves them to the
// scoring computer. See README.md in the repository root.
//
// Settings (environment variables):
//   HUB_KEY       access key the iPads and the scoring computer use (required)
//   HUB_VIEW_KEY  optional second key that can view results but not change them
//   DATA_DIR      folder for the saved copy of the results (attach a volume here)
//   PORT          port to listen on (set by the hosting service)
//   HUB_TIME_SERVERS  time servers to check the hub's clock against, separated
//                 by commas ("none" to leave the clock as it is)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './lib/app.js';
import { defaultTimeServers, HubClock } from './lib/ntp.js';
import { Store } from './lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const minimumKeyLength = 8;

/** Starts a hub. Resolves once it is listening. */
export async function startHub({
  port = 0, host = '0.0.0.0', key = '', viewKey = '', dataDir = null, timeServers = [], publicDir = path.join(here, 'public'), log = () => {},
} = {}) {
  let usableKey = key;
  if (key.length < minimumKeyLength) {
    usableKey = '';
    log(key === ''
      ? 'HUB_KEY is not set: the hub will not accept or show results until it is.'
      : `HUB_KEY is shorter than ${minimumKeyLength} characters and will not be used. Choose a longer one.`);
  }
  const usableViewKey = viewKey.length >= minimumKeyLength && viewKey !== usableKey ? viewKey : '';

  const store = new Store({ dataDir, log });
  // The iPads set their clocks by the hub's, so the hub checks its own
  // against time servers (unless it was given none to ask).
  const clock = new HubClock({ servers: timeServers, log });
  clock.start();
  const handler = createHandler({ store, key: usableKey, viewKey: usableViewKey, publicDir, log, clock });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    store,
    clock,
    port: server.address().port,
    async close() {
      clock.stop();
      store.flush();
      const closed = new Promise((resolve) => server.close(resolve));
      // Idle keep-alive connections would otherwise hold the server open.
      server.closeAllConnections?.();
      await closed;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = (message) => console.log(`[hub] ${message}`);
  const hub = await startHub({
    port: Number(process.env.PORT) || 8080,
    key: process.env.HUB_KEY ?? '',
    viewKey: process.env.HUB_VIEW_KEY ?? '',
    dataDir: process.env.DATA_DIR || path.join(here, 'data'),
    timeServers: process.env.HUB_TIME_SERVERS === undefined
      ? defaultTimeServers
      : process.env.HUB_TIME_SERVERS.split(',').map((name) => name.trim()).filter((name) => name !== '' && name !== 'none'),
    log,
  });
  log(`listening on port ${hub.port}`);
  log(hub.store.persistent
    ? `results are saved in ${process.env.DATA_DIR || path.join(here, 'data')}`
    : 'results are kept in memory only');

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      log(`${signal} received, saving and stopping`);
      await hub.close();
      process.exit(0);
    });
  }
}

// -----------------------------------------------------------------------------
// A real local HTTP server playing the USGS on a sped-up real clock (its
// `Date` header on that clock too: the age is counted from it), and the app
// started against it. Used by the real-clock tests.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WaterApp } from '../../src/app.js';
import { MINUTE } from '../../src/constants.js';
import { createMemoryStore } from '../../src/store.js';
import { latestBody, locationsBody, quiet, series } from './app.js';

/** `answer(n, now)` -> [status, headers, body] for the n-th request of values. */
export async function usgsServer(clock, answer) {
  const reads = [];
  const server = createServer((req, res) => {
    if (req.url.includes('/latest-continuous/')) {
      reads.push(clock.monotonic());
      const [status, headers, body] = answer(reads.length, clock.now());
      res.writeHead(status, {
        'content-type': 'application/json',
        date: new Date(clock.now()).toUTCString(),
        ...headers,
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(locationsBody([{ id: 'USGS-01646500' }])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return { reads, base: `http://127.0.0.1:${server.address().port}/ogcapi/v1`, close };
}

export async function startApp(clock, base) {
  const gladys = createFakeGladys({
    selector: 'ue',
    config: { stations: '01646500', interval_minutes: 15 },
  });
  await gladys.connect();
  const app = new WaterApp({
    gladys,
    logger: quiet(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    base,
  });
  return { gladys, app };
}

/** A current value: measured a minute ago. */
export const fresh = (now) => [200, {}, latestBody([series({ at: now - MINUTE })])];

/** Waits (real time, 5 ms steps) until `done()` or `steps` steps. */
export async function until(done, steps = 2000) {
  for (let i = 0; i < steps && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

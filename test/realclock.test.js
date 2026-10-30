// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, sped
// up 20 times as the project rules ask: the 15 minutes of the shortest
// interval are 45 s) and a real local HTTP server playing the USGS: the reads
// really start at 0 and at the interval, never sooner. One test per file: the
// test timeout of Node 22 counts the whole file. The app is always stopped in
// a `finally`: a failure never leaves the test process alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE } from '../src/constants.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';
import { fresh, startApp, until, usgsServer } from './helpers/realusgs.js';

const INTERVAL = 15 * MINUTE;

test('real clock x20: reads at 0 and at the interval, never sooner; timers bounded', async () => {
  const clock = realClock({ speed: 20 });
  const source = await usgsServer(clock, (n, now) => fresh(now));
  const { gladys, app } = await startApp(clock, source.base);
  const spy = spyOn(app, 'read', clock);
  const started = clock.monotonic();
  try {
    await app.connected(() => gladys.getConfig());
    const gaps = await measurePeriod(spy, { count: 2, period: INTERVAL });
    assert.ok(spy.calls[0].at - started < MINUTE, 'the first read at once');
    for (const gap of gaps) assert.ok(gap >= INTERVAL, `never sooner than the interval: ${gaps}`);
    await until(() => source.reads.length >= 2, 400);
    assert.equal(source.reads.length, 2);
    // Seen by the server too (latency of each request aside: 2 s simulated = 100 ms real).
    assert.ok(source.reads[1] - source.reads[0] >= INTERVAL - 2000, `${source.reads}`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
  } finally {
    await app.stop();
    clock.close();
    await source.close();
  }
  assert.ok(clock.timersSet <= 40, `${clock.timersSet} timers`);
});

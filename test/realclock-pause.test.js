// -----------------------------------------------------------------------------
// The app on a REAL moving clock and a real local HTTP server: after a 429
// longer than the interval, the read comes at the end of the pause, never
// sooner and not a round later (a real timer may fire a little before
// performance.now() says it is due: armed again for the rest). Sped up 60
// times so that a 20 min pause fits in 20 s (the test timeout of Node 22
// counts the whole file). The app is always stopped in a `finally`.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE } from '../src/constants.js';
import { realClock } from './helpers/clock.js';
import { fresh, startApp, until, usgsServer } from './helpers/realusgs.js';

test('real clock x60: after a 429 (Retry-After 20 min) the read comes at the end of the pause', async () => {
  const clock = realClock({ speed: 60 });
  const source = await usgsServer(clock, (n, now) =>
    n === 1 ? [429, { 'retry-after': '1200' }, { error: { code: 'OVER_RATE_LIMIT' } }] : fresh(now),
  );
  const { gladys, app } = await startApp(clock, source.base);
  try {
    await app.connected(() => gladys.getConfig());
    await until(() => source.reads.length >= 2, 8000);
    assert.equal(source.reads.length, 2);
    const gap = source.reads[1] - source.reads[0];
    // 20 min, never sooner; never the round after (30 min).
    assert.ok(gap >= 20 * MINUTE && gap < 22 * MINUTE, `${Math.round(gap / 1000)} s`);
    await until(() => gladys.fake.connectionStatus.connected, 400);
    assert.equal(gladys.fake.connectionStatus.connected, true);
  } finally {
    await app.stop();
    clock.close();
    await source.close();
  }
});

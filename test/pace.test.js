// -----------------------------------------------------------------------------
// The pace of the reads, the pauses, the lifecycle (getConfig, configurations
// saved back to back, reconnections), /data (unreadable, frozen, failing) and
// the search button, on a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevice } from '../src/devices.js';
import { createMemoryStore } from '../src/store.js';
import { settle } from './helpers/clock.js';
import {
  D,
  F,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  json,
  latestBody,
  locationsBody,
  series,
  setup,
} from './helpers/app.js';

const POTOMAC = 'USGS-01646500';
const fresh =
  (t, extra = {}) =>
  () =>
    latestBody([series({ at: t.clock.now() - MINUTE, ...extra })]);

/** A world answering current values, the time of each request kept. */
async function paced(options = {}) {
  const t = await setup({ config: { stations: '01646500' }, world: {}, ...options });
  t.source.world.latest ??= fresh(t);
  t.source.world.locations ??= () => locationsBody([{ id: POTOMAC }]);
  return t;
}

/** Lets an app started without await reach its first timers, then fires the due ones. */
const kick = async (t) => {
  await settle(20);
  await t.wait(0);
  await settle(20);
  await t.wait(0);
};

const gaps = (times) => times.slice(1).map((v, i) => Math.round((v - times[i]) / 1000));

// --- Pace ------------------------------------------------------------------------------

test('the first read at once, then one per interval; nothing else reads sooner', async () => {
  const t = await paced();
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  // A reconnection, the form saved unchanged, the Discovery tab, a device created.
  await t.app.disconnected();
  await t.begin();
  await t.app.configUpdated({ stations: '01646500' });
  await t.app.scan();
  await t.create(POTOMAC);
  await t.wait(14 * MINUTE);
  assert.equal(t.source.count('latest'), 1);
  await t.wait(MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.wait(30 * MINUTE);
  assert.deepEqual(gaps(t.source.times('latest')), [900, 900, 900]);
  await t.app.stop();
});

test('the interval of the form; 15 minutes at least', async () => {
  const t = await paced({ config: { stations: '01646500', interval_minutes: 60 } });
  await t.begin();
  await t.wait(3 * HOUR);
  assert.deepEqual(gaps(t.source.times('latest')), [3600, 3600, 3600]);
  await t.app.stop();
  const u = await paced({ config: { stations: '01646500', interval_minutes: 1 } });
  await u.begin();
  await u.wait(HOUR);
  assert.deepEqual(gaps(u.source.times('latest')), [900, 900, 900, 900]);
  await u.app.stop();
});

test('a new station list: read a minute after the last read at the earliest; an unchanged one waits the interval', async () => {
  const t = await paced();
  await t.begin();
  await t.wait(20 * SECOND);
  await t.app.configUpdated({ stations: '01646500 09380000' });
  await t.app.idle();
  assert.equal(t.source.count('latest'), 1);
  await t.wait(40 * SECOND);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 2);
  const asked = new URL(t.source.requests.filter((r) => r.route === 'latest')[1].url);
  assert.equal(asked.searchParams.get('monitoring_location_id'), 'USGS-01646500,USGS-09380000');
  // Another order is another list: a minute after the last read.
  await t.app.configUpdated({ stations: '09380000, 01646500' });
  await t.wait(2 * MINUTE);
  assert.equal(t.source.count('latest'), 3);
  // The same list saved again: the interval after the last read.
  await t.app.configUpdated({ stations: '09380000, 01646500' });
  await t.wait(13 * MINUTE);
  assert.equal(t.source.count('latest'), 3);
  await t.wait(MINUTE);
  assert.equal(t.source.count('latest'), 4);
  await t.app.stop();
});

test('a restart keeps the pace (the attempt time is in /data before the request)', async () => {
  const store = createMemoryStore();
  const t = await paced({ store });
  t.source.world.latest = () => 'hang';
  t.app.connected(() => t.gladys.getConfig());
  await kick(t);
  assert.equal(t.source.count('latest'), 1);
  assert.ok(Number.isFinite(store.data.lastAttemptAt), 'saved before the answer');
  await t.wait(5 * MINUTE);
  await t.app.stop();
  const u = await paced({ store, start: NOW + 5 * MINUTE });
  await u.begin();
  await u.wait(10 * MINUTE - 2 * SECOND);
  assert.equal(u.source.count('latest'), 0);
  await u.wait(4 * SECOND);
  assert.equal(u.source.count('latest'), 1);
  await u.app.stop();
});

test('/data unreadable, frozen, or a date invalid or in the future: the first read one interval after the start', async () => {
  const cases = {
    unreadable: () => Object.assign(createMemoryStore({ v: 1 }), { broken: true }),
    future: () => createMemoryStore({ lastAttemptAt: NOW + 5 * 24 * HOUR }),
    invalid: () => createMemoryStore({ lastAttemptAt: 'yesterday' }),
    frozen: () => Object.assign(createMemoryStore({ v: 1 }), { holdLoad: new Promise(() => {}) }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const store = make();
    const t = await paced({ store });
    t.app.connected(() => t.gladys.getConfig());
    await kick(t);
    await t.wait(6 * SECOND);
    await t.app.idle();
    // (The frozen load gives up after 5 s: the start is then.)
    await t.wait(15 * MINUTE - 8 * SECOND);
    assert.equal(t.source.count('latest'), 0, name);
    await t.wait(10 * SECOND);
    assert.equal(t.source.count('latest'), 1, name);
    await t.app.stop();
  }
  // No file yet (a first start): at once.
  const t = await paced({ store: createMemoryStore() });
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  await t.app.stop();
  // A file without a read yet (no station at the time): at once too.
  const u = await paced({ store: createMemoryStore({ v: 1, published: {} }) });
  await u.begin();
  assert.equal(u.source.count('latest'), 1);
  await u.app.stop();
});

test('/data unreadable: set aside, never overwritten blindly; the values seen first are a baseline', async () => {
  const store = Object.assign(createMemoryStore({ v: 1 }), { broken: true });
  const device = buildDevice(
    {
      externalIds: (type, id) => ({
        device: `ext:ue:${type}:${id}`,
        feature: (k) => `ext:ue:${type}:${id}:${k}`,
      }),
    },
    { id: POTOMAC, kinds: ['discharge'] },
    { units: 'us', language: 'en' },
  );
  const t = await paced({ store, devices: [device] });
  await t.begin();
  assert.equal(store.asides, 1);
  assert.match(t.status().message.en, /could not be read: set aside/);
  await t.wait(15 * MINUTE);
  await t.app.idle();
  // The first value seen may have been published before the file broke: not sent.
  assert.deepEqual(t.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  assert.equal(t.statesOf(F(POTOMAC, 'status')).length, 1, 'the status text is');
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.equal(t.statesOf(F(POTOMAC, 'discharge-cfs')).length, 1);
  await t.app.stop();
  // Cannot be set aside either: never written.
  const blocked = Object.assign(createMemoryStore({ v: 1 }), { broken: true, failAside: true });
  const u = await paced({ store: blocked });
  await u.begin();
  await u.wait(16 * MINUTE);
  assert.equal(blocked.saves, 0);
  assert.match(u.status().message.en, /\/data cannot be written/);
  await u.app.stop();
});

test('/data frozen at every save: the reads go on at their pace, several in a row', async () => {
  const store = createMemoryStore();
  const t = await paced({ store });
  await t.begin();
  store.hold = new Promise(() => {});
  await t.wait(60 * MINUTE + 30 * SECOND);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 5);
  // Each request waits 5 s at most for the save of its attempt time; the pace stays 15 min.
  for (const gap of gaps(t.source.times('latest'))) assert.ok(gap >= 900 && gap <= 906, `${gap}`);
  const span = (t.source.times('latest').at(-1) - t.source.times('latest')[0]) / 1000;
  assert.ok(span >= 3600 && span <= 3606, `${span}`);
  assert.match(t.status().message.en, /\/data cannot be written/);
  // A stop never waits for /data longer than its bound.
  let done = false;
  const stopped = t.app.stop().then(() => {
    done = true;
  });
  for (let i = 0; i < 10 && !done; i += 1) {
    await settle(10);
    await t.wait(SECOND);
  }
  await stopped;
  assert.ok(done);
});

test('/data failing: said in the status; a success clears it', async () => {
  const store = createMemoryStore();
  const t = await paced({ store });
  store.failSave = true;
  await t.begin();
  assert.match(t.status().message.en, /\/data cannot be written/);
  store.failSave = false;
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.doesNotMatch(t.status().message.en, /\/data/);
  await t.app.stop();
});

// --- Pauses ------------------------------------------------------------------------------

test('a 429: paused as asked (Retry-After), the read armed at its end, never a round later', async () => {
  const t = await paced();
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    return n === 1
      ? json(
          { error: { code: 'OVER_RATE_LIMIT' } },
          { status: 429, headers: { 'retry-after': '1200' } },
        )
      : latestBody([series({ at: t.clock.now() - MINUTE })]);
  };
  await t.begin();
  assert.equal(t.status().connected, false);
  assert.match(
    t.status().message.en,
    /asked to slow down \(too many requests\): paused until Oct 30, 6:26 AM UTC/,
  );
  await t.wait(20 * MINUTE - SECOND);
  assert.equal(t.source.count('latest'), 1);
  await t.wait(2 * SECOND);
  assert.equal(t.source.count('latest'), 2);
  // Then the interval again, from that read.
  await t.wait(15 * MINUTE);
  assert.deepEqual(gaps(t.source.times('latest')), [1200, 900]);
  assert.equal(t.status().connected, true);
  await t.app.stop();
});

test('a pause shorter than the interval does not hurry the next read', async () => {
  const t = await paced();
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    return n === 1
      ? json({}, { status: 503, headers: { 'retry-after': '60' } })
      : latestBody([series({ at: t.clock.now() - MINUTE })]);
  };
  await t.begin();
  await t.wait(30 * MINUTE);
  assert.deepEqual(gaps(t.source.times('latest')), [900, 900]);
  await t.app.stop();
});

test('5xx in a row: the pause doubles; bounded between 60 s and 6 h; a success resets it', async () => {
  const t = await paced({ config: { stations: '01646500', interval_minutes: 15 } });
  let fail = 3;
  t.source.world.latest = () =>
    fail-- > 0 ? json({}, { status: 503 }) : latestBody([series({ at: t.clock.now() - MINUTE })]);
  await t.begin();
  await t.wait(5 * HOUR);
  // 5 min -> read at 15 min (the interval); 10 min -> 30 min; 20 min -> 50 min; then the interval.
  const times = gaps(t.source.times('latest')).slice(0, 4);
  assert.deepEqual(times, [900, 900, 1200, 900]);
  await t.app.stop();
  const u = await paced();
  u.source.world.latest = () => json({}, { status: 429, headers: { 'retry-after': '9999999' } });
  await u.begin();
  await u.wait(6 * HOUR - SECOND);
  assert.equal(u.source.count('latest'), 1);
  await u.wait(2 * SECOND);
  assert.equal(u.source.count('latest'), 2);
  await u.app.stop();
});

test('a timer that fires a little early at the end of a pause never skips a round', async () => {
  // Every timer fires 0.5 ms early (as a real timer against performance.now()).
  const { testClock } = await import('./helpers/clock.js');
  const clock = testClock({ start: NOW });
  const early = {
    setTimeout: (fn, ms, ...args) => clock.timers.setTimeout(fn, Math.max(0, ms - 0.5), ...args),
    clearTimeout: clock.timers.clearTimeout,
  };
  const t = await paced({ clock, timers: early });
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    return n === 1
      ? json({}, { status: 429, headers: { 'retry-after': '300' } })
      : latestBody([series({ at: t.clock.now() - MINUTE })]);
  };
  await t.begin();
  await t.wait(HOUR + SECOND);
  const g = gaps(t.source.times('latest'));
  // Never sooner than the interval, even by the half millisecond of the timer.
  const times = t.source.times('latest');
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 15 * MINUTE);
  // The pause (5 min) is shorter than the interval: the read at 15 min, then every 15.
  assert.deepEqual(g, [900, 900, 900, 900]);
  await t.app.stop();
  // A long pause (20 min) with early timers: the read at 20 min, not 30.
  const clock2 = testClock({ start: NOW });
  const early2 = {
    setTimeout: (fn, ms, ...args) => clock2.timers.setTimeout(fn, Math.max(0, ms - 0.5), ...args),
    clearTimeout: clock2.timers.clearTimeout,
  };
  const u = await paced({ clock: clock2, timers: early2 });
  let m = 0;
  u.source.world.latest = () => {
    m += 1;
    return m === 1
      ? json({}, { status: 429, headers: { 'retry-after': '1200' } })
      : latestBody([series({ at: u.clock.now() - MINUTE })]);
  };
  await u.begin();
  await u.wait(40 * MINUTE);
  assert.deepEqual(gaps(u.source.times('latest')), [1200, 900]);
  const times2 = u.source.times('latest');
  assert.ok(times2[1] - times2[0] >= 20 * MINUTE, 'never before the end of the pause');
  await u.app.stop();
});

test('a pause survives a restart; an end date in /data beyond 6 h is brought back to 6 h', async () => {
  const store = createMemoryStore();
  const t = await paced({ store });
  t.source.world.latest = () => json({}, { status: 429, headers: { 'retry-after': '3600' } });
  await t.begin();
  await t.app.stop();
  assert.equal(store.data.pause.code, 'rate_limited');
  const u = await paced({ store, start: NOW + 10 * MINUTE });
  await u.begin();
  await u.wait(50 * MINUTE - 2 * SECOND);
  assert.equal(u.source.count('latest'), 0);
  assert.match(u.status().message.en, /paused until/);
  await u.wait(3 * SECOND);
  assert.equal(u.source.count('latest'), 1);
  await u.app.stop();
  const far = createMemoryStore({
    lastAttemptAt: NOW - HOUR,
    pause: { until: NOW + 100 * HOUR, count: 2, code: 'server' },
  });
  const v = await paced({ store: far });
  await v.begin();
  await v.wait(6 * HOUR - 2 * SECOND);
  assert.equal(v.source.count('latest'), 0);
  await v.wait(3 * SECOND);
  assert.equal(v.source.count('latest'), 1);
  await v.app.stop();
  // A pause of another kind in /data is not a pause.
  const odd = createMemoryStore({
    lastAttemptAt: NOW - HOUR,
    pause: { until: NOW + HOUR, count: 1, code: 'network' },
  });
  const w = await paced({ store: odd });
  await w.begin();
  assert.equal(w.source.count('latest'), 1);
  await w.app.stop();
});

test('during a long pause the status texts still age (no request)', async () => {
  const t = await paced();
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    return n === 1
      ? latestBody([series({ at: t.clock.now() - 2 * HOUR })])
      : json({}, { status: 429, headers: { 'retry-after': '21600' } });
  };
  await t.begin();
  await t.create(POTOMAC);
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.wait(2 * HOUR);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 2);
  const texts = t.statesOf(F(POTOMAC, 'status')).map((s) => s.text);
  assert.match(texts.at(-1), /^No current value/);
  assert.equal(t.status().connected, false);
  await t.app.stop();
});

// --- Lifecycle -----------------------------------------------------------------------------

test('getConfig failing in "connected": tried again without end, the status says it, then the reads', async () => {
  const t = await paced();
  let fail = 3;
  const getConfig = async () => {
    if (fail-- > 0) throw new Error('timeout');
    return t.gladys.getConfig();
  };
  t.app.connected(getConfig);
  await kick(t);
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /could not be read from Gladys: new try in 1 min/);
  await t.wait(5 * SECOND);
  await t.wait(10 * SECOND);
  assert.equal(t.source.count('latest'), 0);
  await t.wait(20 * SECOND);
  await kick(t);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 1);
  assert.equal(t.status().connected, true);
  await t.app.stop();
});

test('getConfig failing for long: spaced up to 5 min, never given up; a saved form wins', async () => {
  const t = await paced();
  let calls = 0;
  t.app.connected(async () => {
    calls += 1;
    throw new Error('down');
  });
  for (let i = 0; i < 60; i += 1) {
    await settle(5);
    await t.wait(MINUTE);
  }
  assert.ok(calls >= 12 && calls <= 20, `${calls} tries`);
  await t.app.configUpdated({ stations: '01646500' });
  await kick(t);
  await t.app.idle();
  const before = calls;
  await t.wait(HOUR);
  assert.equal(calls, before, 'the retries ended with the form');
  assert.equal(t.source.count('latest'), 5);
  await t.app.stop();
});

test('configurations saved back to back: applied one by one, the last one wins, nothing published as 0', async () => {
  const t = await paced();
  t.source.world.latest = (url) => {
    const ids = new URL(url).searchParams.get('monitoring_location_id').split(',');
    return latestBody(ids.map((station) => series({ station, at: t.clock.now() - MINUTE })));
  };
  t.source.world.locations = (url) =>
    locationsBody(
      new URL(url).searchParams
        .get('id')
        .split(',')
        .map((id) => ({ id })),
    );
  await t.begin();
  await t.create(POTOMAC);
  const saves = [
    t.app.configUpdated({ stations: '09380000' }),
    t.app.configUpdated({ stations: '12113000', units: 'metric' }),
    t.app.configUpdated({ stations: '01646500, 12113000', language: 'fr' }),
  ];
  await Promise.all(saves);
  await t.app.idle();
  assert.deepEqual(t.app.config.stations, ['USGS-01646500', 'USGS-12113000']);
  assert.equal(t.app.config.language, 'fr');
  assert.equal(t.app.config.units, 'us');
  await t.wait(MINUTE);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 2, 'one read for the last list, a minute after the first');
  assert.deepEqual(
    t.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D(POTOMAC), D('USGS-12113000')],
  );
  for (const s of t.gladys.fake.states) assert.notEqual(s.state, 0);
  await t.app.stop();
});

test('a configuration saved during a read: the read in flight is cut and its answer dropped', async () => {
  const t = await paced();
  let release;
  t.source.world.latest = (url) =>
    url.includes('09380000')
      ? latestBody([series({ station: 'USGS-09380000', at: t.clock.now() - MINUTE })])
      : new Promise((resolve) => {
          release = () => resolve(latestBody([series({ at: t.clock.now() - MINUTE })]));
        });
  t.app.connected(() => t.gladys.getConfig());
  await kick(t);
  assert.equal(t.source.count('latest'), 1);
  await t.app.configUpdated({ stations: '09380000' });
  release?.();
  await kick(t);
  await t.app.idle();
  assert.deepEqual(t.gladys.fake.discoveredDevices, []);
  await t.wait(MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D('USGS-09380000')],
  );
  await t.app.stop();
});

test('a read cut before its values came (same list saved, reconnection): read again a minute later', async () => {
  for (const cut of ['save', 'reconnection']) {
    const t = await paced();
    let n = 0;
    t.source.world.latest = () => {
      n += 1;
      return n === 2 ? 'hang' : latestBody([series({ at: t.clock.now() - MINUTE })]);
    };
    await t.begin();
    await t.wait(15 * MINUTE);
    assert.equal(t.source.count('latest'), 2, cut);
    if (cut === 'save') {
      await t.app.configUpdated({ stations: '01646500', language: 'fr' });
    } else {
      await t.app.disconnected();
      t.app.connected(() => t.gladys.getConfig());
    }
    await kick(t);
    await t.wait(MINUTE - 2 * SECOND);
    assert.equal(t.source.count('latest'), 2, cut);
    await t.wait(3 * SECOND);
    assert.equal(t.source.count('latest'), 3, cut);
    // Then the interval from that read.
    await t.wait(15 * MINUTE - 2 * SECOND);
    assert.equal(t.source.count('latest'), 3, cut);
    await t.wait(3 * SECOND);
    assert.equal(t.source.count('latest'), 4, cut);
    await t.app.stop();
  }
});

test('a save after the values came (during the publication) reads nothing sooner', async () => {
  const t = await paced();
  await t.begin();
  await t.create(POTOMAC);
  const publish = t.gladys.publishStates.bind(t.gladys);
  let release;
  t.gladys.publishStates = (states) =>
    new Promise((resolve) => {
      release = () => resolve(publish(states));
    });
  t.source.world.latest = fresh(t);
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.app.configUpdated({ stations: '01646500', language: 'fr' });
  release?.();
  t.gladys.publishStates = publish;
  await kick(t);
  await t.wait(14 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.wait(2 * MINUTE);
  assert.equal(t.source.count('latest'), 3);
  await t.app.stop();
});

test('a read due while a refresh still runs (slow Gladys) starts as soon as it ends', async () => {
  const t = await paced();
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    return n === 1
      ? latestBody([series({ at: t.clock.now() - 2 * HOUR - 35 * MINUTE })])
      : n === 2
        ? json({}, { status: 429, headers: { 'retry-after': '1200' } })
        : latestBody([series({ at: t.clock.now() - MINUTE })]);
  };
  await t.begin();
  await t.create(POTOMAC);
  const publish = t.gladys.publishStates.bind(t.gladys);
  let release;
  await t.wait(14 * MINUTE);
  await t.wait(MINUTE);
  assert.equal(t.source.count('latest'), 2, 'the 429 at 15 min: paused until 35 min');
  t.gladys.publishStates = (states) =>
    new Promise((resolve) => {
      release = () => resolve(publish(states));
    });
  // The refresh at 30 min hangs on Gladys (the status text went stale).
  await t.wait(15 * MINUTE);
  assert.ok(release, 'the refresh publishes the stale status');
  await t.wait(5 * MINUTE + 10 * SECOND);
  assert.equal(t.source.count('latest'), 2, 'due at 35 min, the refresh still runs');
  t.gladys.publishStates = publish;
  release();
  await settle(20);
  await t.wait(0);
  assert.equal(t.source.count('latest'), 3, 'at once when the refresh ends, not a minute later');
  await t.app.stop();
});

test('a reconnection or a save during a publication sends nothing twice', async () => {
  const t = await paced();
  await t.begin();
  const publish = t.gladys.publishStates.bind(t.gladys);
  let release;
  t.gladys.publishStates = (states) =>
    new Promise((resolve) => {
      release = () => resolve(publish(states));
    });
  const created = t.create(POTOMAC);
  await settle(5);
  await t.app.configUpdated({ stations: '01646500' });
  await t.app.disconnected();
  t.app.connected(() => t.gladys.getConfig());
  await settle(5);
  for (let i = 0; i < 5 && release; i += 1) {
    const r = release;
    release = undefined;
    r();
    await settle(10);
  }
  await created;
  await t.app.idle();
  assert.equal(t.statesOf(F(POTOMAC, 'discharge-cfs')).length, 1);
  await t.app.stop();
});

test('disconnected: no read until the next connection; the pace kept', async () => {
  const t = await paced();
  await t.begin();
  await t.app.disconnected();
  await t.wait(HOUR);
  assert.equal(t.source.count('latest'), 1);
  await t.begin();
  assert.equal(t.source.count('latest'), 2, 'due long ago: at once');
  await t.wait(10 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.app.stop();
});

test('a request that hangs is cut after 20 s; the next read at its time; a stop cuts it at once', async () => {
  const t = await paced();
  t.source.world.latest = () => 'hang';
  t.app.connected(() => t.gladys.getConfig());
  await kick(t);
  await t.wait(21 * SECOND);
  await t.wait(6 * SECOND);
  await t.app.idle();
  assert.match(t.status().message.en, /no answer in time/);
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.app.stop();
  assert.equal(t.app.busy, undefined);
});

test('an answer too large is cut, never read whole', async () => {
  const t = await paced();
  let pulled = 0;
  t.source.world.latest = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          if (pulled > 1000) controller.close();
        },
      }),
      { status: 200 },
    );
  await t.begin();
  assert.ok(pulled <= 40, `${pulled} chunks read`);
  assert.match(t.status().message.en, /answer too large/);
  await t.app.stop();
});

// --- Search ---------------------------------------------------------------------------------

test('search: one request with the words only, the numbers to copy; spaced, never during a pause', async () => {
  const t = await paced({ config: { stations: '' } });
  t.source.world.search = () =>
    locationsBody([
      { id: 'USGS-12113000', name: 'GREEN RIVER NEAR AUBURN, WA', state: 'Washington' },
      { id: 'AR008-343826091361301', name: 'WELL', siteType: 'Well', state: 'Arkansas' },
    ]);
  await t.begin();
  const answer = await t.app.search({ query: "green' river" });
  assert.equal(
    answer.en,
    'Copy the number into "Stations":\n12113000: GREEN RIVER NEAR AUBURN, WA - Stream, Washington\nAR008-343826091361301: WELL - Well, Arkansas',
  );
  const asked = new URL(t.source.requests[0].url);
  assert.equal(
    asked.searchParams.get('filter'),
    "monitoring_location_name LIKE '%GREEN%' AND monitoring_location_name LIKE '%RIVER%'",
  );
  assert.match(
    (await t.app.search({ query: 'potomac' })).en,
    /One search at a time: try again in 10 s/,
  );
  assert.equal(t.source.count('search'), 1);
  assert.match((await t.app.search({ query: "' ;" })).en, /^Type a word/);
  await t.wait(10 * SECOND);
  t.source.world.search = () => json({}, { status: 429, headers: { 'retry-after': '600' } });
  assert.match(
    (await t.app.search({ query: 'potomac' })).en,
    /Search failed \(too many requests\)/,
  );
  await t.wait(10 * SECOND);
  assert.match((await t.app.search({ query: 'potomac' })).en, /no search until/);
  assert.equal(t.source.count('search'), 2);
  await t.wait(10 * MINUTE);
  t.source.world.search = () => locationsBody([]);
  assert.match(
    (await t.app.search({ query: 'potomac' })).en,
    /No USGS station name holds "POTOMAC"/,
  );
  await t.app.stop();
});

test('search: a 429 pauses the reads too; a 5xx does not', async () => {
  const t = await paced();
  await t.begin();
  t.source.world.search = () => json({}, { status: 503 });
  await t.app.search({ query: 'potomac' });
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  t.source.world.search = () => json({}, { status: 429, headers: { 'retry-after': '1800' } });
  await t.wait(10 * SECOND);
  await t.app.search({ query: 'potomac' });
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  await t.wait(16 * MINUTE);
  assert.equal(t.source.count('latest'), 3);
  await t.app.stop();
});

test('search behind a read that hangs: one request at a time; a search not started in 45 s is dropped', async () => {
  const t = await paced();
  t.source.world.latest = () => 'hang';
  t.source.world.search = () => locationsBody([]);
  t.app.connected(() => t.gladys.getConfig());
  await kick(t);
  assert.equal(t.source.count('latest'), 1);
  const answer = t.app.search({ query: 'potomac' });
  await t.wait(SECOND);
  assert.equal(t.source.count('search'), 0, 'never alongside the read');
  await t.wait(20 * SECOND);
  await t.app.idle();
  assert.match((await answer).en, /No USGS station name holds/);
  assert.equal(t.source.count('search'), 1);
  await t.app.stop();
  // A queue held longer than the wait: the search gives up and never leaves later.
  const u = await paced();
  u.source.world.search = () => locationsBody([]);
  let hold;
  u.app.hostQueue = new Promise((resolve) => {
    hold = resolve;
  });
  const late = u.app.search({ query: 'potomac' });
  await settle(20);
  await u.wait(46 * SECOND);
  assert.match((await late).en, /A read of the stations is running/);
  hold();
  await settle(10);
  assert.equal(u.source.count('search'), 0);
  await u.app.stop();
});

// --- Guards (each one held by a test) -------------------------------------------------------

test('a getConfig answering after a saved form never overrides it, nor its status', async () => {
  const t = await paced();
  let answer;
  let refuse;
  t.app.connected(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      }),
  );
  await settle(10);
  await t.app.configUpdated({ stations: '09380000' });
  await kick(t);
  answer({ stations: '12113000' });
  await kick(t);
  await t.app.idle();
  assert.deepEqual(t.app.config.stations, ['USGS-09380000']);
  // An older connection whose getConfig fails late: no "could not be read".
  const u = await paced();
  u.app.connected(
    () =>
      new Promise((resolve, reject) => {
        refuse = reject;
      }),
  );
  await settle(10);
  await u.app.configUpdated({ stations: '01646500' });
  await kick(u);
  refuse(new Error('late'));
  await kick(u);
  await u.app.idle();
  assert.doesNotMatch(u.status().message.en, /could not be read from Gladys/);
  await u.wait(HOUR);
  assert.doesNotMatch(u.status().message.en, /could not be read from Gladys/);
  void answer;
  await t.app.stop();
  await u.app.stop();
});

test('a new station list: "waiting for the first read" until it is read, never the old count', async () => {
  const t = await paced();
  await t.begin();
  assert.match(t.status().message.en, /^1 station\(s\) read/);
  await t.app.configUpdated({ stations: '01646500 09380000' });
  await t.app.idle();
  assert.match(t.status().message.en, /^Waiting for the first read \(in 1 min at most\)/);
  assert.equal(t.status().connected, false);
  await t.app.stop();
});

test('a station removed from the form: its device gets nothing more, /data forgets it', async () => {
  const t = await paced();
  t.source.world.latest = (url) =>
    latestBody(
      new URL(url).searchParams
        .get('monitoring_location_id')
        .split(',')
        .map((station) => series({ station, at: t.clock.now() - MINUTE })),
    );
  t.source.world.locations = (url) =>
    locationsBody(
      new URL(url).searchParams
        .get('id')
        .split(',')
        .map((id) => ({ id })),
    );
  await t.begin();
  await t.create(POTOMAC);
  const before = t.gladys.fake.states.length;
  await t.app.configUpdated({ stations: '09380000' });
  await t.wait(2 * MINUTE);
  await t.wait(15 * MINUTE);
  await t.app.idle();
  const after = t.gladys.fake.states.slice(before);
  assert.deepEqual(
    after.filter((s) => s.device_feature_external_id.includes(POTOMAC)),
    [],
  );
  assert.deepEqual(
    t.store.data.stations.map((s) => s.id),
    ['USGS-09380000'],
  );
  await t.app.stop();
});

test('the Discovery list is sent again only when it changed (or asked by the tab)', async () => {
  const t = await paced();
  let calls = 0;
  const original = t.gladys.publishDiscoveredDevices.bind(t.gladys);
  t.gladys.publishDiscoveredDevices = (devices) => {
    calls += 1;
    return original(devices);
  };
  await t.begin();
  const first = calls;
  await t.wait(HOUR);
  assert.equal(calls, first);
  await t.app.scan();
  assert.equal(calls, first + 1);
  await t.app.stop();
});

test('an early timer re-arms for the rest: no refresh, a bounded number of timers', async () => {
  const { testClock } = await import('./helpers/clock.js');
  const clock = testClock({ start: NOW });
  let set = 0;
  const early = {
    setTimeout: (fn, ms, ...args) => {
      set += 1;
      return clock.timers.setTimeout(fn, Math.max(0, ms - 0.5), ...args);
    },
    clearTimeout: clock.timers.clearTimeout,
  };
  const t = await paced({ clock, timers: early });
  let refreshes = 0;
  const refresh = t.app.refresh.bind(t.app);
  t.app.refresh = (gen) => {
    refreshes += 1;
    return refresh(gen);
  };
  await t.begin();
  await t.wait(HOUR + SECOND);
  assert.equal(t.source.count('latest'), 5);
  assert.equal(refreshes, 0, 'an early wake-up is not a refresh');
  assert.ok(set < 60, `${set} timers in an hour`);
  await t.app.stop();
});

test('a success ends the pause and its doubling: the next 5xx pauses 5 min again', async () => {
  const t = await paced();
  const answers = ['503', 'ok', 'ok', '503', 'ok'];
  let n = 0;
  t.source.world.latest = () =>
    answers[n++] === '503'
      ? json({}, { status: 503 })
      : latestBody([series({ at: t.clock.now() - MINUTE })]);
  await t.begin();
  await t.wait(45 * MINUTE);
  assert.equal(t.source.count('latest'), 4);
  assert.equal(t.app.pause.count, 1, 'a new pause, not the second of a row');
  assert.equal(Math.round((t.app.pause.until - t.clock.now()) / MINUTE), 5);
  await t.app.stop();
});

test('a 5xx of the names with a long Retry-After never delays the values', async () => {
  const t = await paced();
  t.source.world.locations = () => json({}, { status: 503, headers: { 'retry-after': '7200' } });
  await t.begin();
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  assert.equal(t.app.pause, undefined);
  await t.app.stop();
});

test('a 429 of a search is in /data at once (a restart keeps it)', async () => {
  const t = await paced();
  await t.begin();
  t.source.world.search = () => json({}, { status: 429, headers: { 'retry-after': '1800' } });
  await t.app.search({ query: 'potomac' });
  assert.equal(t.store.data.pause?.code, 'rate_limited');
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 1);
  assert.match(t.status().message.en, /^1 station\(s\) read.*paused until/);
  await t.app.stop();
});

test('a pause in /data: a count of 0 is no pause; a huge count is brought to 32', async () => {
  const zero = createMemoryStore({
    lastAttemptAt: NOW - HOUR,
    pause: { until: NOW + HOUR, count: 0, code: 'server' },
  });
  const t = await paced({ store: zero });
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  await t.app.stop();
  const huge = createMemoryStore({
    lastAttemptAt: NOW - HOUR,
    pause: { until: NOW + HOUR, count: 1e9, code: 'server' },
  });
  const u = await paced({ store: huge });
  await u.begin();
  await u.app.stop();
  assert.equal(huge.data.pause.count, 32);
});

test('a stop waits 3 s at most for a read held by a frozen Gladys', async () => {
  const t = await paced();
  await t.begin();
  await t.create(POTOMAC);
  t.gladys.publishStates = () => new Promise(() => {});
  t.source.world.latest = fresh(t);
  await t.wait(15 * MINUTE);
  assert.ok(t.app.busy, 'the read is held');
  let done = false;
  const stopped = t.app.stop().then(() => {
    done = true;
  });
  await settle(20);
  await t.wait(3 * SECOND + 10);
  await settle(20);
  await t.wait(5 * SECOND);
  await settle(20);
  assert.ok(done, 'stopped');
  await stopped;
});

test('a read whose values failed asks nothing else (no names request)', async () => {
  const t = await paced();
  t.source.world.latest = () => new Error('down');
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  assert.equal(t.source.count('locations'), 0);
  await t.app.stop();
});

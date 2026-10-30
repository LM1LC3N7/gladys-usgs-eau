// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys, a scripted USGS and a virtual clock:
// reads, Discovery, publication, freshness, statuses.
// Pace, pauses, lifecycle and /data: test/pace.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  BASE,
  D,
  F,
  HOUR,
  MINUTE,
  NOW,
  REAL_STATIONS,
  json,
  latestBody,
  liveWorld,
  locationsBody,
  series,
  setup,
} from './helpers/app.js';

const POTOMAC = 'USGS-01646500';
const DRY = 'USGS-354144078460101';
const WELL = 'USGS-405118099514901';

test('real captures: one request, Discovery with names and the kinds seen, values once created', async () => {
  const t = await setup({ config: { stations: REAL_STATIONS } });
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  assert.equal(t.source.count('locations'), 1);
  const headers = t.source.requests[0].headers;
  assert.match(
    headers['User-Agent'],
    /^gladys-usgs-eau\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\//,
  );
  assert.equal(headers.Accept, 'application/geo+json, application/json;q=0.9');
  const found = t.gladys.fake.discoveredDevices;
  assert.deepEqual(
    found.map((d) => d.name),
    [
      'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (USGS-01646500)',
      'COLORADO RIVER AT LEES FERRY, AZ (USGS-09380000)',
      'GREEN RIVER NEAR AUBURN, WA (USGS-12113000)',
      'WK-436 CROWDER PARK NR HOLLY SPRINGS NC REGOLITH (USGS-354144078460101)',
      '10N 22W 8BCBB1-Site7-20 (USGS-405118099514901)',
      'SAN MARCIAL ADDED (USGS-00000000)',
    ],
  );
  const keys = (id) =>
    found.find((d) => d.external_id === D(id)).features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(keys(POTOMAC), [
    'discharge-cfs',
    'gage-height-ft',
    'water-temperature-f',
    'status',
  ]);
  assert.deepEqual(keys(DRY), ['status']);
  assert.deepEqual(keys(WELL), ['groundwater-depth-ft', 'status']);
  // Nothing published before a device exists.
  assert.equal(t.gladys.fake.states.length, 0);
  await t.create(POTOMAC);
  await t.create(DRY);
  await t.create(WELL);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [2450],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'gage-height-ft')).map((s) => s.state),
    [2.92],
  );
  // 16.2 °C = 61.16 °F exactly; the 2019 series of the station are never shown.
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'water-temperature-f')).map((s) => s.state),
    [61.16],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Measured Oct 30, 1:50 AM EDT'],
  );
  assert.deepEqual(
    t.statesOf(F(DRY, 'status')).map((s) => s.text),
    ['No value (dry), Oct 30, 1:45 AM EDT'],
  );
  assert.deepEqual(
    t.statesOf(F(WELL, 'groundwater-depth-ft')).map((s) => s.state),
    [8.54],
  );
  for (const s of t.gladys.fake.states) assert.equal(s.created_at, undefined);
  assert.deepEqual(t.status(), {
    connected: true,
    message: {
      en: '6 station(s) read, 4 with a current value.',
      fr: '6 station(s) lue(s), 4 avec une valeur récente.',
    },
  });
  await t.app.stop();
});

test('metric units: exact conversions; °C as the USGS gives it', async () => {
  const t = await setup({ config: { stations: REAL_STATIONS, units: 'metric', language: 'fr' } });
  await t.begin();
  await t.create(POTOMAC);
  await t.create('USGS-09380000');
  await t.app.idle();
  // 2450 ft³/s x 0.028316846592 = 69.376274... m³/s; 2.92 ft x 0.3048 = 0.890016 m.
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-m3s')).map((s) => s.state),
    [69.3763],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'gage-height-m')).map((s) => s.state),
    [0.89],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'water-temperature-c')).map((s) => s.state),
    [16.2],
  );
  // Lees Ferry, Arizona: no daylight saving (MST all year).
  assert.deepEqual(
    t.statesOf(F('USGS-09380000', 'status')).map((s) => s.text),
    ['Mesuré le 29 oct., 23:00 UTC−7'],
  );
  const device = t.gladys.fake.discoveredDevices.find((d) => d.external_id === D(POTOMAC));
  assert.deepEqual(
    device.features.map((f) => [f.name, f.unit ?? null, f.min, f.max]),
    [
      ['Débit (m³/s)', null, -14158, 283168],
      ["Hauteur à l'échelle", 'm', -152, 6096],
      ["Température de l'eau", 'celsius', -5, 50],
      ['État', null, 0, 0],
    ],
  );
  await t.app.stop();
});

test('a device keeps the units of its creation when the form changes them', async () => {
  const world = liveWorld(undefined, () => []);
  const t = await setup({ config: { stations: '01646500' }, world });
  let value = '100';
  t.source.world.latest = () =>
    latestBody([series({ param: '00060', at: t.clock.now() - MINUTE, value })]);
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  await t.gladys.fake.updateConfig?.({ stations: '01646500', units: 'metric' });
  await t.app.configUpdated({ stations: '01646500', units: 'metric' });
  await t.app.idle();
  // Discovery now offers the metric features...
  const device = t.gladys.fake.discoveredDevices.find((d) => d.external_id === D(POTOMAC));
  assert.ok(device.features.some((f) => f.external_id === F(POTOMAC, 'discharge-m3s')));
  // ...but the device created in U.S. units keeps receiving ft³/s, never m³/s.
  value = '200';
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100, 200],
  );
  assert.deepEqual(t.statesOf(F(POTOMAC, 'discharge-m3s')), []);
  await t.app.stop();
});

test('each measurement is published once; a newer one is; an older one never', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  let at = NOW - 10 * MINUTE;
  let value = '100';
  let tsid = 'b';
  t.source.world.latest = () => latestBody([series({ at, value, tsid })]);
  await t.begin();
  await t.create(POTOMAC);
  await t.wait(15 * MINUTE); // same measurement
  at += 15 * MINUTE;
  value = '120';
  await t.wait(15 * MINUTE); // newer
  at -= 30 * MINUTE;
  tsid = 'a';
  value = '999';
  await t.wait(15 * MINUTE); // another series, older measurement
  await t.app.idle();
  assert.equal(t.source.count('latest'), 4);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100, 120],
  );
  await t.app.stop();
});

test('a value without number (dry, ice, a text, empty) is never published, never 0', async () => {
  const t = await setup({ config: { stations: '01646500 09380000 12113000 405118099514901' } });
  const at = NOW - 5 * MINUTE;
  t.source.world.latest = () =>
    latestBody([
      series({ station: POTOMAC, at, value: '50', tsid: 'z' }),
      series({ station: POTOMAC, param: '00065', at, value: null, qualifier: ['ICE'] }),
      series({ station: 'USGS-09380000', at, value: 'Ice' }),
      series({ station: 'USGS-12113000', at, value: '' }),
      series({ station: WELL, param: '72019', at, value: null, qualifier: ['EQUIPMENT'] }),
    ]);
  t.source.world.locations = () => locationsBody([{ id: POTOMAC }]);
  await t.begin();
  for (const id of [POTOMAC, 'USGS-09380000', 'USGS-12113000', WELL]) await t.create(id);
  await t.app.idle();
  const numbers = t.gladys.fake.states.filter((s) => s.state !== undefined);
  assert.deepEqual(
    numbers.map((s) => [s.device_feature_external_id, s.state]),
    [[F(POTOMAC, 'discharge-cfs'), 50]],
  );
  const text = (id) => t.statesOf(F(id, 'status')).map((s) => s.text);
  assert.deepEqual(text('USGS-09380000'), ['Unreadable value at the source']);
  assert.deepEqual(text('USGS-12113000'), ['Unreadable value at the source']);
  assert.deepEqual(text(WELL), ['No value (equipment malfunction), Oct 30, 6:01 AM UTC']);
  assert.equal(t.status().connected, true);
  await t.app.stop();
});

test('a stale value is never published; the status says when it was measured', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - 3 * HOUR - MINUTE })]);
  t.source.world.locations = () => locationsBody([{ id: POTOMAC }]);
  await t.begin();
  await t.create(POTOMAC);
  await t.app.idle();
  assert.deepEqual(t.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['No current value; last one Oct 29, 11:05 PM EDT'],
  );
  // The service answers, but nothing is current: never "connected".
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /none of the 1 station\(s\) has a current value/);
  // A device listed only once read; a never-current kind gives no feature.
  const device = t.gladys.fake.discoveredDevices.find((d) => d.external_id === D(POTOMAC));
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    ['status'],
  );
  await t.app.stop();
});

test('the maximum age of the form; exactly at it the value is current', async () => {
  const t = await setup({ config: { stations: '01646500', max_age_hours: 6 }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - 5 * HOUR, value: '7' })]);
  await t.begin();
  await t.create(POTOMAC);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [7],
  );
  await t.app.stop();
});

test('a value going stale between reads: the status text says it at the next wake-up, nothing republished', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  let up = true;
  t.source.world.latest = () =>
    up ? latestBody([series({ at: NOW - 2 * HOUR })]) : new Error('down');
  await t.begin();
  await t.create(POTOMAC);
  up = false;
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /Last read failed \(network error\)/);
  await t.wait(60 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Measured Oct 30, 4:06 AM UTC', 'No current value; last one Oct 30, 4:06 AM UTC'],
  );
  await t.app.stop();
});

test('the age is measured against the Date of the answer, not a wrong local clock', async () => {
  // Our clock is 5 h late; the server Date is right: the value is 10 min old.
  const t = await setup({ config: { stations: '01646500' }, start: NOW - 5 * HOUR, world: {} });
  t.source.world.latest = () =>
    json(latestBody([series({ at: NOW - 10 * MINUTE })]), {
      headers: { date: new Date(NOW).toUTCString() },
    });
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  await t.app.stop();
  // A Date further than a day from our clock is not believed: our clock decides.
  const u = await setup({ config: { stations: '01646500' }, world: {} });
  u.source.world.latest = () =>
    json(latestBody([series({ at: NOW - 10 * MINUTE })]), {
      headers: { date: new Date(NOW + 2 * 24 * HOUR).toUTCString() },
    });
  await u.begin();
  await u.create(POTOMAC);
  assert.deepEqual(
    u.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  await u.app.stop();
  // No Date at all: our clock too.
  const v = await setup({ config: { stations: '01646500' }, world: {} });
  v.source.world.latest = () => json(latestBody([series({ at: NOW - 4 * HOUR })]));
  await v.begin();
  await v.create(POTOMAC);
  assert.deepEqual(v.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  await v.app.stop();
});

test('a value dated in the future (beyond 15 min) is unreadable', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW + 20 * MINUTE })]);
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(t.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Unreadable value at the source'],
  );
  await t.app.stop();
});

test('a format that changed (every series refused) is an error, never "no data"', async () => {
  for (const features of [
    [series({ at: NOW, unit: 'cubic-feet' })],
    [{ type: 'Feature', properties: { station: POTOMAC, flow: 3 } }],
    [series({ at: NOW, param: '99999' })],
  ]) {
    const t = await setup({ config: { stations: '01646500' }, world: {} });
    t.source.world.latest = () => latestBody(features);
    await t.begin();
    assert.equal(t.status().connected, false);
    assert.match(t.status().message.en, /Last read failed \(unexpected answer\)/);
    assert.deepEqual(t.gladys.fake.discoveredDevices, []);
    await t.app.stop();
  }
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => ({ type: 'FeatureCollection', items: [] });
  await t.begin();
  assert.match(t.status().message.en, /unexpected answer/);
  await t.app.stop();
});

test('no series at all: "no continuous data", never a value', async () => {
  const t = await setup({ config: { stations: '01646500 00000000' }, world: {} });
  t.source.world.latest = () => latestBody([]);
  t.source.world.locations = () => locationsBody([{ id: POTOMAC }]);
  await t.begin();
  await t.create(POTOMAC);
  await t.create('USGS-00000000');
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['No continuous data at this station'],
  );
  assert.deepEqual(
    t.statesOf(F('USGS-00000000', 'status')).map((s) => s.text),
    ['Station unknown to the USGS'],
  );
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /1 station\(s\) unknown to the USGS/);
  await t.app.stop();
});

test('pages: the next one on the same endpoint is followed; another host or too many: incomplete, nothing new', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  const next = `${BASE}/collections/latest-continuous/items?cursor=abc`;
  t.source.world.latest = (url) =>
    url.includes('cursor=abc')
      ? latestBody([series({ param: '00065', at: NOW - MINUTE, value: '3' })])
      : latestBody([series({ at: NOW - MINUTE })], [{ rel: 'next', href: next }]);
  await t.begin();
  await t.create(POTOMAC);
  assert.equal(t.source.count('latest'), 2);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'gage-height-ft')).map((s) => s.state),
    [3],
  );
  await t.app.stop();

  for (const href of [
    'https://evil.test/ogcapi/v1/collections/latest-continuous/items?c=1',
    'invalid',
    next,
  ]) {
    const u = await setup({ config: { stations: '01646500' }, world: {} });
    u.source.world.latest = () =>
      latestBody(
        [series({ at: NOW - MINUTE })],
        [{ rel: 'next', href: href === 'invalid' ? 3 : href }],
      );
    await u.begin();
    assert.equal(u.source.count('latest'), href === next ? 3 : 1);
    assert.equal(u.status().connected, false);
    assert.match(u.status().message.en, /answer incomplete/);
    assert.deepEqual(u.gladys.fake.discoveredDevices, []);
    await u.app.stop();
  }
});

test('a device created gets the current values at once, without a request; a stale one never', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - 2 * HOUR })]);
  await t.begin();
  await t.wait(10 * MINUTE);
  const asked = t.source.requests.length;
  await t.create(POTOMAC);
  assert.equal(t.source.requests.length, asked, 'no request for a device created');
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  await t.app.stop();
  // The source fails, the value in memory ages past the maximum age: a device
  // created then gets the status, never the stale value.
  const u = await setup({ config: { stations: '01646500' }, world: {} });
  u.source.world.latest = () => latestBody([series({ at: NOW - 2 * HOUR - 50 * MINUTE })]);
  await u.begin();
  u.source.world.latest = () => new Error('down');
  await u.wait(15 * MINUTE);
  await u.create(POTOMAC);
  assert.deepEqual(u.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  assert.deepEqual(
    u.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['No current value; last one Oct 30, 3:16 AM UTC'],
  );
  await u.app.stop();
});

test('a reconnection or a restart sends nothing again but the status texts', async () => {
  const store = createMemoryStore();
  const t = await setup({ config: { stations: '01646500' }, store, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - MINUTE })]);
  await t.begin();
  await t.create(POTOMAC);
  await t.app.disconnected();
  await t.begin();
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  assert.equal(t.statesOf(F(POTOMAC, 'status')).length, 2, 'the status text is sent again');
  await t.app.stop();
  // A new process on the same /data: the measurement is known.
  const u = await setup({
    config: { stations: '01646500' },
    store,
    world: t.source.world,
    start: NOW + 16 * MINUTE,
    devices: [structuredClone(t.gladys.devices.find((d) => d.external_id === D(POTOMAC)))],
  });
  await u.begin();
  await u.wait(15 * MINUTE);
  await u.app.idle();
  assert.deepEqual(u.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  await u.app.stop();
});

test('several series of one kind: the current one of smallest id, stable from read to read', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  let n = 0;
  t.source.world.latest = () => {
    n += 1;
    const at = NOW + (n - 1) * 15 * MINUTE - MINUTE;
    return latestBody([
      series({ param: '00010', at: at - (n % 2) * 5 * MINUTE, value: '10', tsid: 'b' }),
      series({ param: '00010', at: at - ((n + 1) % 2) * 5 * MINUTE, value: '20', tsid: 'c' }),
      series({ param: '00010', at: Date.UTC(2019, 9, 1), value: '24', tsid: 'a' }),
    ]);
  };
  await t.begin();
  await t.create(POTOMAC);
  await t.wait(15 * MINUTE);
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'water-temperature-f')).map((s) => s.state),
    [50, 50, 50],
  );
  await t.app.stop();
});

test('the status of a station lists the kinds no longer current', async () => {
  const t = await setup({ config: { stations: '01646500', language: 'fr' }, world: {} });
  let gage = NOW - MINUTE;
  t.source.world.latest = () =>
    latestBody([
      series({ at: t.clock.now() - MINUTE }),
      series({ param: '00065', at: gage, value: '2' }),
    ]);
  await t.begin();
  await t.create(POTOMAC);
  gage = NOW - 4 * HOUR;
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Mesuré le 30 oct., 06:05 UTC', 'Mesuré le 30 oct., 06:20 UTC ; pas à jour : hauteur'],
  );
  await t.app.stop();
});

test('the state budget: at most 250 states a minute, the rest at the next round, said in the status', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () =>
    latestBody([
      series({ at: t.clock.now() - MINUTE }),
      series({ param: '00065', at: t.clock.now() - MINUTE, value: '2' }),
    ]);
  await t.begin();
  await t.create(POTOMAC);
  const before = t.gladys.fake.states.length;
  await t.wait(15 * MINUTE - 2000);
  t.app.sentLog.push({ at: t.clock.monotonic(), n: 249 });
  await t.wait(2000);
  await t.app.idle();
  assert.equal(t.gladys.fake.states.length - before, 1);
  assert.match(t.status().message.en, /Some values wait for the next read/);
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.ok(t.gladys.fake.states.length - before >= 4);
  await t.app.stop();
});

test('publishStates refused: the measurement is sent again at the next read', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - MINUTE })]);
  await t.begin();
  const publish = t.gladys.publishStates.bind(t.gladys);
  let fail = true;
  t.gladys.publishStates = async (states) => {
    if (fail) throw new Error('refused');
    return publish(states);
  };
  await t.create(POTOMAC);
  assert.deepEqual(t.statesOf(F(POTOMAC, 'discharge-cfs')), []);
  fail = false;
  await t.wait(15 * MINUTE);
  await t.app.idle();
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  await t.app.stop();
});

test('names not read (secondary endpoint failing): values all the same, ids as names, times in UTC', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: t.clock.now() - MINUTE })]);
  t.source.world.locations = () => json({ error: 'x' }, { status: 500 });
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  assert.equal(t.gladys.fake.discoveredDevices[0].name, 'USGS-01646500');
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Measured Oct 30, 6:05 AM UTC'],
  );
  assert.equal(t.status().connected, true);
  assert.match(
    t.status().message.en,
    /Station names not read \(service unavailable \(HTTP 500\)\)/,
  );
  // A 5xx of the secondary endpoint never pauses the values; it is tried again an hour later.
  await t.wait(15 * MINUTE);
  assert.equal(t.source.count('latest'), 2);
  assert.equal(t.source.count('locations'), 1);
  t.source.world.locations = () => locationsBody([{ id: POTOMAC, name: 'POTOMAC' }]);
  await t.wait(45 * MINUTE);
  await t.app.idle();
  assert.equal(t.source.count('latest'), 5);
  assert.equal(t.source.count('locations'), 2);
  assert.equal(t.gladys.fake.discoveredDevices[0].name, 'POTOMAC (USGS-01646500)');
  assert.doesNotMatch(t.status().message.en, /Station names/);
  await t.app.stop();
});

test('names: read once a week, not at every read', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: t.clock.now() - MINUTE })]);
  t.source.world.locations = () => locationsBody([{ id: POTOMAC }]);
  await t.begin();
  await t.wait(6 * 24 * HOUR);
  assert.equal(t.source.count('locations'), 1);
  await t.wait(24 * HOUR + 15 * MINUTE);
  assert.equal(t.source.count('locations'), 2);
  await t.app.stop();
});

test('no station: the status says how to add one; never a request', async () => {
  const t = await setup({ config: { stations: '' } });
  await t.begin();
  await t.wait(2 * HOUR);
  assert.equal(t.source.requests.length, 0);
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /^No station: type USGS station numbers/);
  await t.app.stop();
});

test('notes of the form are in the status, never the value typed', async () => {
  const t = await setup({
    config: { stations: '01646500, <script>', interval_minutes: 3, units: 'furlongs' },
    world: {},
  });
  t.source.world.latest = () => latestBody([series({ at: t.clock.now() - MINUTE })]);
  await t.begin();
  const message = t.status().message.en;
  assert.match(message, /not USGS station numbers and were ignored/);
  assert.match(message, /Read interval out of range/);
  assert.match(message, /Unknown unit system/);
  assert.doesNotMatch(message, /script|furlongs/);
  await t.app.stop();
});

test('a format guard: series with a value but no readable time are not "no data"', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: undefined }), series({ param: '00065' })]);
  await t.begin();
  assert.match(t.status().message.en, /Last read failed \(unexpected answer\)/);
  await t.app.stop();
});

test('stale everywhere: the status gives the latest measurement of the station', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () =>
    latestBody([
      series({ at: NOW - 5 * HOUR }),
      series({ param: '00065', at: NOW - 4 * HOUR, value: '2' }),
      series({ param: '00010', at: NOW - 6 * HOUR, value: '2' }),
    ]);
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['No current value; last one Oct 30, 2:06 AM UTC'],
  );
  await t.app.stop();
});

test('a refused publication leaves no trace of the measurement (sent again)', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - MINUTE })]);
  await t.begin();
  t.gladys.publishStates = async () => {
    throw new Error('refused');
  };
  await t.create(POTOMAC);
  assert.equal(t.app.published.has(F(POTOMAC, 'discharge-cfs')), false);
  await t.app.stop();
});

test('a device created again (no delete seen) gets the current values again', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  t.source.world.latest = () => latestBody([series({ at: NOW - MINUTE })]);
  await t.begin();
  await t.create(POTOMAC);
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100, 100],
  );
  await t.app.stop();
});

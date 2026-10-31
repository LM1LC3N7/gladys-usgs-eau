// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys, a scripted USGS and a virtual clock:
// reads, Discovery, publication, freshness, statuses.
// Pace, pauses, lifecycle and /data: test/pace.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
import { KINDS, buildDevice } from '../src/devices.js';
import { createMemoryStore } from '../src/store.js';
import { settle } from './helpers/clock.js';
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
const DRYFLOW = 'USGS-11157500';
const BLWMIN = 'USGS-07076750';
const ESTIMATED = 'USGS-07105900';

test('real captures: one request, Discovery with names and the kinds seen, values once created', async () => {
  const t = await setup({ config: { stations: REAL_STATIONS } });
  await t.begin();
  assert.equal(t.source.count('latest'), 1);
  assert.equal(t.source.count('locations'), 1);
  const headers = t.source.requests[0].headers;
  assert.match(
    headers['User-Agent'],
    new RegExp(
      `^gladys-usgs-eau/${PKG.version.replaceAll('.', '\\.')} \\(\\+https://github\\.com/LM1LC3N7/`,
    ),
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
      'JIMMY CAMP CREEK AT FOUNTAIN, CO. (USGS-07105900)',
      'TRES PINOS C NR TRES PINOS CA (USGS-11157500)',
      'White River at Georgetown, AR (USGS-07076750)',
      'ST. CLAIR RIVER AT PORT HURON, MI (USGS-04159130)',
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
  // A dry gauge (DRY with 0.00) and a gauge below its minimum (BLWMIN): no feature.
  assert.deepEqual(keys(DRYFLOW), ['status']);
  assert.deepEqual(keys(BLWMIN), ['status']);
  // An estimated discharge is a value (said in the status).
  assert.deepEqual(keys(ESTIMATED), [
    'discharge-cfs',
    'gage-height-ft',
    'water-temperature-f',
    'status',
  ]);
  // Nothing published before a device exists.
  assert.equal(t.gladys.fake.states.length, 0);
  for (const id of [POTOMAC, DRY, WELL, DRYFLOW, BLWMIN, ESTIMATED, 'USGS-04159130']) {
    await t.create(id);
  }
  await t.app.idle();
  const values = (id, key) => t.statesOf(F(id, key)).map((s) => s.state);
  const texts = (id) => t.statesOf(F(id, 'status')).map((s) => s.text);
  assert.deepEqual(values(POTOMAC, 'discharge-cfs'), [2400]);
  assert.deepEqual(values(POTOMAC, 'gage-height-ft'), [2.91]);
  // 15.9 °C = 60.62 °F exactly; the 2019 series of the station are never shown.
  assert.deepEqual(values(POTOMAC, 'water-temperature-f'), [60.62]);
  assert.deepEqual(texts(POTOMAC), ['Measured Oct 30, 6:50 AM EDT (provisional)']);
  assert.deepEqual(texts(DRY), ['No value (dry), Oct 30, 6:45 AM EDT']);
  assert.deepEqual(values(WELL, 'groundwater-depth-ft'), [8.54]);
  // DRY 0.00 ft³/s: never a 0; BLWMIN 7620 ft³/s for a gage of 0.12 ft: never published.
  assert.equal(
    t.gladys.fake.states.filter(
      (s) => s.device_feature_external_id.includes(DRYFLOW) && s.state !== undefined,
    ).length,
    0,
  );
  assert.deepEqual(texts(DRYFLOW), ['No value (dry), Oct 30, 4:00 AM PDT']);
  assert.equal(
    t.gladys.fake.states.filter(
      (s) => s.device_feature_external_id.includes(BLWMIN) && s.state !== undefined,
    ).length,
    0,
  );
  assert.deepEqual(texts(BLWMIN), ['No value (below the minimum measurable), Oct 30, 6:00 AM CDT']);
  // ESTIMATED 0.89 ft³/s: published, the status says it.
  assert.deepEqual(values(ESTIMATED, 'discharge-cfs'), [0.89]);
  assert.deepEqual(texts(ESTIMATED), ['Measured Oct 30, 4:45 AM MDT (estimated, provisional)']);
  // Port Huron: EST "without daylight saving" for the USGS, EDT in fact.
  assert.match(texts('USGS-04159130')[0], /^Measured Oct 30, 7:00 AM EDT/);
  for (const s of t.gladys.fake.states) assert.equal(s.created_at, undefined);
  assert.deepEqual(t.status(), {
    connected: true,
    message: {
      en: '10 station(s) read, 6 with a current value. 1 station(s) with values the USGS qualifies (estimated, revised...): see their status.',
      fr: "10 station(s) lue(s), 6 avec une valeur récente. 1 station(s) dont l'USGS qualifie les valeurs (estimées, révisées…) : voir leur état.",
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
  // 2400 ft³/s x 0.028316846592 = 67.960431... m³/s; 2.91 ft x 0.3048 = 0.886968 m.
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-m3s')).map((s) => s.state),
    [67.9604],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'gage-height-m')).map((s) => s.state),
    [0.887],
  );
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'water-temperature-c')).map((s) => s.state),
    [15.9],
  );
  // Lees Ferry, Arizona: no daylight saving (MST all year).
  assert.deepEqual(
    t.statesOf(F('USGS-09380000', 'status')).map((s) => s.text),
    ['Mesuré le 30 oct., 04:00 UTC−7 (provisoire)'],
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
      series({ station: WELL, param: '72019', at, value: null, qualifier: ['EQUIP'] }),
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
  assert.deepEqual(text(WELL), ['No value (equipment malfunction), Oct 30, 11:40 AM UTC']);
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
    ['No current value; last one Oct 30, 4:44 AM EDT'],
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
    ['Measured Oct 30, 9:45 AM UTC', 'No current value; last one Oct 30, 9:45 AM UTC'],
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
    ['No current value; last one Oct 30, 8:55 AM UTC'],
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
    ['Mesuré le 30 oct., 11:44 UTC', 'Mesuré le 30 oct., 11:59 UTC ; pas à jour : hauteur'],
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
    ['Measured Oct 30, 11:44 AM UTC'],
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
    ['No current value; last one Oct 30, 7:45 AM UTC'],
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

// --- Review r1 (I4) ---------------------------------------------------------------------------

/** A device of a station with every value feature (both unit systems) and the status. */
function fullDevice(id) {
  const fake = {
    externalIds: (type, sid) => ({
      device: `ext:ue:${type}:${sid}`,
      feature: (key) => `ext:ue:${type}:${sid}:${key}`,
    }),
  };
  const us = buildDevice(fake, { id, kinds: KINDS }, { units: 'us', language: 'en' });
  const metric = buildDevice(fake, { id, kinds: KINDS }, { units: 'metric', language: 'en' });
  return {
    ...us,
    features: [
      ...us.features,
      ...metric.features.filter((f) => !f.external_id.endsWith(':status')),
    ],
  };
}

const STATIONS20 = Array.from({ length: 20 }, (_, i) => `USGS-${String(10000000 + i)}`);
const allKinds = (station, at, value = '10') => [
  series({ station, param: '00060', at, value }),
  series({ station, param: '00065', at, value }),
  series({ station, param: '00010', at, value }),
  series({ station, param: '72019', at, value }),
];

test('values go to Gladys in batches of 100 states at most', async () => {
  const t = await setup({
    config: { stations: STATIONS20.join(',') },
    world: {},
    devices: STATIONS20.map(fullDevice),
  });
  t.source.world.latest = () => latestBody(STATIONS20.flatMap((s) => allKinds(s, NOW - MINUTE)));
  const sizes = [];
  const publish = t.gladys.publishStates.bind(t.gladys);
  t.gladys.publishStates = (states) => {
    sizes.push(states.length);
    return publish(states);
  };
  await t.begin();
  await t.app.idle();
  // 20 stations x 8 value features = 160 values: 100 + 60; then 20 status texts.
  assert.deepEqual(sizes, [100, 60, 20]);
  await t.app.stop();
});

test('the budget counts the states before they are sent: a device created in the same minute waits', async () => {
  const t = await setup({ config: { stations: '01646500 09380000' }, world: {} });
  let at = NOW - MINUTE;
  t.source.world.latest = () =>
    latestBody([...allKinds('USGS-01646500', at), ...allKinds('USGS-09380000', at)]);
  await t.begin();
  await t.create('USGS-01646500');
  at += 15 * MINUTE;
  await t.wait(15 * MINUTE - 2000);
  t.app.sentLog.push({ at: t.clock.monotonic(), n: 246 });
  await t.wait(2000);
  await t.app.idle();
  // 4 values sent (246 + 4 = 250), the status put off.
  assert.equal(t.statesOf(F('USGS-01646500', 'discharge-cfs')).length, 2);
  await t.create('USGS-09380000');
  await t.app.idle();
  assert.deepEqual(t.statesOf(F('USGS-09380000', 'discharge-cfs')), [], 'no budget left');
  await t.app.stop();
});

test('a refused batch never restores a mark someone cleared meanwhile (device deleted)', async () => {
  const t = await setup({ config: { stations: '01646500' }, world: {} });
  let at = NOW - MINUTE;
  t.source.world.latest = () => latestBody([series({ at })]);
  await t.begin();
  await t.create(POTOMAC);
  const fid = F(POTOMAC, 'discharge-cfs');
  assert.equal(t.app.published.get(fid), NOW - MINUTE);
  let refuse;
  t.gladys.publishStates = () =>
    new Promise((resolve, reject) => {
      refuse = reject;
    });
  at += 15 * MINUTE;
  await t.wait(15 * MINUTE);
  assert.ok(refuse, 'the new value is being sent');
  await t.app.onDeviceDeleted({ external_id: D(POTOMAC) });
  refuse(new Error('refused'));
  await settle(20);
  assert.equal(t.app.published.has(fid), false);
  await t.app.stop();
});

test('the marks of the values published are capped at 400 (the oldest dropped)', async () => {
  const kept = Object.fromEntries(
    Array.from({ length: 399 }, (_, i) => [
      `ext:ue:station:USGS-${20000000 + i}:discharge-cfs`,
      NOW,
    ]),
  );
  const store = createMemoryStore({ lastAttemptAt: NOW - HOUR, published: kept });
  const t = await setup({
    config: { stations: STATIONS20.join(',') },
    world: {},
    store,
    devices: STATIONS20.map(fullDevice),
  });
  t.source.world.latest = () => latestBody(STATIONS20.flatMap((s) => allKinds(s, NOW - MINUTE)));
  await t.begin();
  await t.app.idle();
  assert.equal(t.app.published.size, 400);
  // The newest are kept: those just sent.
  assert.ok(t.app.published.has(F(STATIONS20[19], 'discharge-cfs')));
  await t.app.stop();
});

test('a qualifier sent as a plain string is read; nuancing codes are said, invalidating ones block', async () => {
  const t = await setup({ config: { stations: '01646500', language: 'fr' }, world: {} });
  t.source.world.latest = () =>
    latestBody([
      series({ at: NOW - MINUTE, qualifier: 'ESTIMATED', approval: 'Provisional' }),
      series({ param: '00065', at: NOW - MINUTE, value: '3', qualifier: 'Ice' }),
      series({ param: '00010', at: NOW - MINUTE, value: '9', qualifier: ['REVISED'] }),
    ]);
  await t.begin();
  await t.create(POTOMAC);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'discharge-cfs')).map((s) => s.state),
    [100],
  );
  assert.deepEqual(t.statesOf(F(POTOMAC, 'gage-height-ft')), []);
  assert.deepEqual(
    t.statesOf(F(POTOMAC, 'status')).map((s) => s.text),
    ['Mesuré le 30 oct., 11:44 UTC (estimée, révisée, provisoire)'],
  );
  await t.app.stop();
});

test('a dry well with a number: never a depth of water', async () => {
  const t = await setup({ config: { stations: '354144078460101' }, world: {} });
  let qualifier = null;
  t.source.world.latest = () =>
    latestBody([
      series({
        station: 'USGS-354144078460101',
        param: '72019',
        at: t.clock.now() - MINUTE,
        value: '14.13',
        qualifier,
      }),
    ]);
  await t.begin();
  await t.create('USGS-354144078460101');
  qualifier = ['DRY', 'EQUIP'];
  await t.wait(15 * MINUTE);
  await t.app.idle();
  const fid = F('USGS-354144078460101', 'groundwater-depth-ft');
  assert.deepEqual(
    t.statesOf(fid).map((s) => s.state),
    [14.13],
    'only the first, unqualified one',
  );
  assert.deepEqual(
    t.statesOf(F('USGS-354144078460101', 'status')).map((s) => s.text),
    [
      'Measured Oct 30, 11:44 AM UTC',
      'No value (dry, equipment malfunction), Oct 30, 11:59 AM UTC',
    ],
  );
  await t.app.stop();
});

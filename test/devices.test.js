import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, parseDeviceId, validId } from '../src/devices.js';
import { deviceStatus, qualifierText } from '../src/i18n.js';

const gladys = {
  externalId: (suffix) => `ext:ue:${suffix}`,
};

test('the device id of this integration only, with a valid station id', () => {
  assert.equal(parseDeviceId(gladys, 'ext:ue:station:USGS-01646500'), 'USGS-01646500');
  assert.equal(parseDeviceId(gladys, 'ext:other:station:USGS-01646500'), undefined);
  assert.equal(parseDeviceId(gladys, 'ext:xx:station:USGS-01646500'), undefined);
  assert.equal(parseDeviceId(gladys, 'ext:ue:station:../etc'), undefined);
  assert.equal(parseDeviceId(gladys, 'ext:ue:station:USGS-01646500:status'), undefined);
  assert.equal(parseDeviceId(gladys, 3), undefined);
  for (const bad of ['US.GS-01646500', 'U:S-01646500', 'U/S-01646500']) {
    assert.equal(validId(bad), false, bad);
  }
});

test('conversions: exact, rounded, never a negative zero', () => {
  const c = (key, v) => FEATURES.get(key).convert(v);
  assert.equal(c('discharge-cfs', 2450), 2450);
  assert.equal(c('discharge-m3s', 2450), 69.3763);
  assert.equal(c('discharge-m3s', 1 / 0.028316846592), 1);
  assert.equal(c('gage-height-m', 10), 3.048);
  assert.equal(c('water-temperature-f', 16.2), 61.16);
  assert.equal(c('water-temperature-f', -5), 23);
  assert.equal(c('water-temperature-c', 16.25), 16.25);
  assert.equal(c('groundwater-depth-m', -15.88), -4.84);
  assert.ok(Object.is(c('discharge-cfs', -0.0001), 0));
  assert.ok(Object.is(c('gage-height-m', -0.0001), 0));
});

test('status texts: bounded to 120 characters, a reason even when the USGS gives none', () => {
  const long = deviceStatus('fr', {
    code: 'novalue',
    time: Date.UTC(2026, 9, 30, 5, 50),
    zone: 'America/New_York',
    qualifiers: ['A'.repeat(24), 'B'.repeat(24), 'C'.repeat(24), 'D'.repeat(24)],
  });
  assert.ok(long.length <= 120, `${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.equal(qualifierText('en', []), 'no reason given');
  assert.equal(qualifierText('fr', undefined), 'sans raison donnée');
  assert.equal(qualifierText('en', ['ICE', 'XYZ']), 'ice, XYZ');
  assert.equal(
    deviceStatus('en', {
      code: 'novalue',
      time: Date.UTC(2026, 9, 30, 5, 50),
      zone: 'UTC',
      qualifiers: [],
    }),
    'No value (no reason given), Oct 30, 5:50 AM UTC',
  );
});

test('station times: the zone of the station, across a change of time and at midnight', () => {
  const t = (at, zone, lang = 'en') =>
    deviceStatus(lang, { code: 'ok', time: at, zone, behind: [] });
  // 1 November 2026: 1:30 AM happens twice in New York (EDT then EST).
  assert.equal(t(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York'), 'Measured Nov 1, 1:30 AM EDT');
  assert.equal(t(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York'), 'Measured Nov 1, 1:30 AM EST');
  // 8 March 2026: 2:30 AM never happens; 7:30 UTC is 3:30 AM EDT.
  assert.equal(t(Date.UTC(2026, 2, 8, 7, 30), 'America/New_York'), 'Measured Mar 8, 3:30 AM EDT');
  // Midnight, east and west: the date of the station, not of UTC.
  assert.equal(t(Date.UTC(2026, 9, 30, 4, 0), 'America/New_York'), 'Measured Oct 30, 12:00 AM EDT');
  assert.equal(
    t(Date.UTC(2026, 9, 30, 9, 59), 'Pacific/Honolulu'),
    'Measured Oct 29, 11:59 PM HST',
  );
  assert.equal(
    t(Date.UTC(2026, 9, 30, 10, 0), 'Pacific/Honolulu', 'fr'),
    'Mesuré le 30 oct., 00:00 UTC−10',
  );
  // Arizona: no daylight saving.
  assert.equal(t(Date.UTC(2026, 6, 1, 12, 0), 'America/Phoenix'), 'Measured Jul 1, 5:00 AM MST');
  // A zone Intl does not know: UTC.
  assert.equal(t(Date.UTC(2026, 9, 30, 4, 0), 'Nowhere/Land'), 'Measured Oct 30, 4:00 AM UTC');
});

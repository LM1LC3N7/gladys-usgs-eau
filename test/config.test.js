import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseStations, stationIdOf } from '../src/config.js';

test('the defaults', () => {
  assert.deepEqual(normalizeConfig(), {
    stations: [],
    units: 'us',
    language: 'en',
    intervalMinutes: 15,
    maxAgeHours: 3,
    notes: [],
  });
  for (const raw of [null, 'x', [], 3]) assert.deepEqual(normalizeConfig(raw).notes, []);
  assert.equal(DEFAULT_CONFIG.stations, '');
});

test('station ids: bare USGS numbers, agency ids, nothing else', () => {
  assert.equal(stationIdOf('01646500'), 'USGS-01646500');
  assert.equal(stationIdOf(' usgs-01646500 '), 'USGS-01646500');
  assert.equal(stationIdOf('AR008-343826091361301'), 'AR008-343826091361301');
  assert.equal(stationIdOf('354144078460101'), 'USGS-354144078460101');
  for (const bad of [
    '1646500',
    '1234567890123456',
    'USGS-1646500',
    'TOOLONG-01646500',
    'USGS_01646500',
    'USGS-01646500.1',
    'USGS-0164:6500',
    '../01646500',
    '',
    'USGS-',
  ]) {
    assert.equal(stationIdOf(bad), undefined, bad);
  }
});

test('the station field: separators, duplicates, refused entries, at most 20', () => {
  assert.deepEqual(parseStations('01646500, 09380000;12113000\n01646500 usgs-09380000'), {
    ids: ['USGS-01646500', 'USGS-09380000', 'USGS-12113000'],
    invalid: 0,
    cut: false,
  });
  assert.deepEqual(parseStations('01646500, abc, 123'), {
    ids: ['USGS-01646500'],
    invalid: 2,
    cut: false,
  });
  const many = Array.from({ length: 25 }, (_, i) => String(10000000 + i)).join(',');
  const parsed = parseStations(many);
  assert.equal(parsed.ids.length, 20);
  assert.equal(parsed.cut, true);
  assert.equal(parseStations(12345678).ids[0], 'USGS-12345678');
  assert.deepEqual(parseStations({}).ids, []);
  assert.equal(parseStations(`${'01646500 '.repeat(250)}`).cut, true);
  const notes = normalizeConfig({ stations: `${many}, x` }).notes;
  assert.deepEqual(notes, ['stations_invalid', 'stations_cut']);
});

test('numbers: strict, bounded, never 0 from an empty field', () => {
  const n = (interval_minutes, max_age_hours) =>
    normalizeConfig({ interval_minutes, max_age_hours });
  assert.equal(n(30).intervalMinutes, 30);
  assert.equal(n('45').intervalMinutes, 45);
  assert.equal(n('').intervalMinutes, 15);
  assert.equal(n(null).intervalMinutes, 15);
  assert.equal(n(5).intervalMinutes, 15);
  assert.equal(n(0).intervalMinutes, 15);
  assert.equal(n(500).intervalMinutes, 120);
  assert.equal(n(15).intervalMinutes, 15);
  assert.equal(n(120).intervalMinutes, 120);
  assert.equal(n(14).intervalMinutes, 15);
  assert.equal(n(121).intervalMinutes, 120);
  assert.equal(n('12.5').intervalMinutes, 15);
  assert.equal(n(12.5).intervalMinutes, 15);
  assert.equal(n(-20).intervalMinutes, 15);
  assert.equal(n('abc').intervalMinutes, 15);
  assert.deepEqual(n(14).notes, ['interval']);
  assert.deepEqual(n(30).notes, []);
  assert.equal(n(undefined, 24).maxAgeHours, 24);
  assert.equal(n(undefined, 0).maxAgeHours, 1);
  assert.equal(n(undefined, 49).maxAgeHours, 48);
  assert.equal(n(undefined, 1).maxAgeHours, 1);
  assert.equal(n(undefined, 48).maxAgeHours, 48);
  assert.deepEqual(n(undefined, 49).notes, ['max_age']);
});

test('selects: a known value, else the default with a note', () => {
  assert.equal(normalizeConfig({ units: 'metric' }).units, 'metric');
  assert.equal(normalizeConfig({ language: 'fr' }).language, 'fr');
  const odd = normalizeConfig({ units: 'imperial', language: 'de' });
  assert.equal(odd.units, 'us');
  assert.equal(odd.language, 'en');
  assert.deepEqual(odd.notes, ['units', 'language']);
  assert.deepEqual(normalizeConfig({ units: '', language: null }).notes, []);
});

test('numbers typed: only plain digits, never hexadecimal nor exponent', () => {
  for (const typed of ['0x1E', '1e2', ' 30', '30 ', '+30', '3_0']) {
    const config = normalizeConfig({ interval_minutes: typed });
    assert.equal(config.intervalMinutes, 15, typed);
    assert.deepEqual(config.notes, ['interval'], typed);
  }
});

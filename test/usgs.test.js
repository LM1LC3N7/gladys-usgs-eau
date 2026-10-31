// -----------------------------------------------------------------------------
// The parsers of the USGS answers (src/usgs.js), on the real captures of
// 2026-10-30 and on built answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUTURE_SLACK, HOUR, MINUTE } from '../src/constants.js';
import {
  BOUNDS,
  FormatError,
  cleanText,
  latestUrl,
  locationsUrl,
  parseInstant,
  parseLatest,
  parseLocations,
  parseValue,
  qualifiersOf,
  NUANCING,
  searchUrl,
  searchWords,
  selectSeries,
  zoneOf,
} from '../src/usgs.js';
import { QUALIFIER_CODES } from '../src/i18n.js';
import { BASE, fixture, latestBody, series } from './helpers/app.js';

const REAL = new Set([
  'USGS-07105900',
  'USGS-11157500',
  'USGS-07076750',
  'USGS-04159130',
  'USGS-01646500',
  'USGS-09380000',
  'USGS-12113000',
  'USGS-354144078460101',
  'USGS-405118099514901',
  'USGS-00000000',
]);
const parse = (features, asked = new Set(['USGS-01646500'])) =>
  parseLatest(JSON.stringify(latestBody(features)), asked);
const AT = Date.UTC(2026, 9, 30, 10, 50);

test('the real capture: every series of the stations asked, values in the canonical units', () => {
  const {
    series: list,
    total,
    ignored,
    next,
  } = parseLatest(fixture('latest-continuous.json'), REAL);
  assert.equal(total, 24);
  assert.equal(ignored, 0);
  assert.equal(next, undefined);
  const potomac = list.filter((s) => s.station === 'USGS-01646500');
  assert.deepEqual(potomac.map((s) => s.kind).sort(), [
    'discharge',
    'gage-height',
    'water-temperature',
    'water-temperature',
    'water-temperature',
    'water-temperature',
    'water-temperature',
  ]);
  const flow = potomac.find((s) => s.kind === 'discharge');
  assert.equal(flow.value, 2400);
  assert.equal(flow.time, AT);
  assert.equal(flow.provisional, true);
  assert.equal(flow.blocked, false);
  assert.equal(potomac.find((s) => s.time < AT).provisional, false, 'the 2019 series are approved');
  const dry = list.find((s) => s.station === 'USGS-354144078460101');
  assert.equal(dry.value, null);
  assert.deepEqual(dry.qualifiers, ['DRY']);
  assert.equal(dry.kind, 'groundwater-depth');
  // A dry stream gauge with a number (0.00): the number is kept, the code blocks it.
  const dryFlow = list.find((s) => s.station === 'USGS-11157500' && s.kind === 'discharge');
  assert.equal(dryFlow.value, 0);
  assert.equal(dryFlow.blocked, true);
  const below = list.find((s) => s.station === 'USGS-07076750' && s.kind === 'discharge');
  assert.equal(below.value, 7620);
  assert.deepEqual(below.qualifiers, ['BLWMIN']);
  assert.equal(below.blocked, true);
  const estimated = list.find((s) => s.station === 'USGS-07105900' && s.kind === 'discharge');
  assert.deepEqual(estimated.qualifiers, ['ESTIMATED']);
  assert.equal(estimated.blocked, false);
  // Discharge in m³/s (parameter 30208), converted to ft³/s.
  const cms = list.filter((s) => s.station === 'USGS-04159130' && s.kind === 'discharge');
  assert.deepEqual(
    cms.map((s) => Math.round(s.value)).sort((a, b) => a - b),
    [205531, 206000],
  );
});

test('the real capture of the locations: names, zones (the daylight saving flag of the USGS is not trusted)', () => {
  const { locations } = parseLocations(fixture('monitoring-locations.json'));
  assert.equal(locations.size, 10);
  assert.equal(
    locations.get('USGS-01646500').name,
    'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
  );
  assert.equal(locations.get('USGS-01646500').zone, 'America/New_York');
  assert.equal(locations.get('USGS-09380000').zone, 'America/Phoenix');
  assert.equal(locations.get('USGS-12113000').zone, 'America/Los_Angeles');
  assert.equal(locations.get('USGS-405118099514901').zone, 'America/Chicago');
  // Port Huron, Michigan: "EST, no daylight saving" for the USGS; Michigan follows it.
  assert.equal(locations.get('USGS-04159130').zone, 'America/New_York');
  assert.equal(locations.get('USGS-354144078460101').siteType, 'Well');
});

test('a value is a plain decimal or a number; a text, an empty string, NaN are not; null stays null', () => {
  assert.equal(parseValue('2450'), 2450);
  assert.equal(parseValue('-15.88'), -15.88);
  assert.equal(parseValue(' 7.90 '), 7.9);
  assert.equal(parseValue(3), 3);
  assert.equal(parseValue(null), null);
  for (const bad of [
    '',
    ' ',
    'Ice',
    'Eqp',
    '1e3',
    '0x10',
    '1,5',
    '12.',
    '.5',
    NaN,
    Infinity,
    [],
    {},
    true,
  ]) {
    assert.equal(parseValue(bad), undefined, String(bad));
  }
  assert.equal(parseValue('1234567890'), undefined, 'ten digits: not a measurement');
  assert.equal(parseValue('123456789'), 123456789);
  assert.equal(parseValue('1.1234567'), undefined);
});

test('an instant needs a date, a time and an offset; impossible dates are refused', () => {
  const AT = Date.UTC(2026, 9, 30, 5, 50);
  assert.equal(parseInstant('2026-10-30T05:50:00+00:00'), AT);
  assert.equal(parseInstant('2026-10-30T01:50:00-04:00'), AT);
  assert.equal(parseInstant('2026-10-30T05:50Z'), AT);
  assert.equal(parseInstant('2026-10-30T05:50:00.000Z'), AT);
  assert.equal(parseInstant('2026-10-30T11:20:00+05:30'), AT);
  for (const bad of [
    '2026-10-30T05:50:00',
    '2026-10-30',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-30T24:00:00Z',
    '2026-10-30T05:60:00Z',
    '2026-10-30T05:50:60Z',
    '2026-10-30T05:50:00+15:00',
    '2026-10-30T05:50:00+01:60',
    '2026-00-10T05:50:00Z',
    ' 2026-10-30T05:50:00Z',
    `${'9'.repeat(41)}`,
    1234,
    null,
  ]) {
    assert.equal(parseInstant(bad), undefined, String(bad));
  }
});

test('units: converted exactly to cfs, ft and °C; an unknown unit or a value out of range is unreadable', () => {
  const at = AT;
  const { series: list } = parse([
    series({ param: '00060', at, value: '1', unit: 'm^3/s', tsid: 'a' }),
    series({ param: '00065', at, value: '3.048', unit: 'm', tsid: 'b' }),
    series({ param: '00010', at, value: '104', unit: 'degF', tsid: 'c' }),
    series({ param: '00010', at, value: '20', unit: 'kelvin', tsid: 'd' }),
    series({ param: '00060', at, value: '-999999', tsid: 'e' }),
    series({ param: '00065', at, value: '-999999', tsid: 'f' }),
    series({ param: '00010', at, value: '51', tsid: 'g' }),
    series({ param: '00010', at, value: '-6', tsid: 'h' }),
    series({ param: '00010', at, value: '50', tsid: 'i' }),
    series({ param: '00010', at, value: '-5', tsid: 'j' }),
  ]);
  const by = Object.fromEntries(list.map((s) => [s.tsid, s.value]));
  assert.ok(Math.abs(by.a - 35.31466672148859) < 1e-9, `${by.a}`);
  assert.ok(Math.abs(by.b - 10) < 1e-12);
  assert.ok(Math.abs(by.c - 40) < 1e-12);
  assert.equal(by.d, undefined);
  assert.equal(by.e, undefined);
  assert.equal(by.f, undefined);
  assert.equal(by.g, undefined);
  assert.equal(by.h, undefined);
  assert.equal(by.i, 50);
  assert.equal(by.j, -5);
  for (const [kind, [min, max]] of Object.entries(BOUNDS)) {
    assert.ok(min < 0 && max > 0, kind);
  }
});

test('the range of each kind is checked at its two ends', () => {
  const at = AT;
  const check = (param, value, unit) =>
    parse([series({ param, at, value: String(value), unit })]).series[0].value;
  assert.equal(check('00060', -500000), -500000);
  assert.equal(check('00060', -500001), undefined);
  assert.equal(check('00060', 10000000), 10000000);
  assert.equal(check('00060', 10000001), undefined);
  assert.equal(check('00065', -500), -500);
  assert.equal(check('00065', -501), undefined);
  assert.equal(check('00065', 20000), 20000);
  assert.equal(check('00065', 20001), undefined);
  assert.equal(check('72019', -1000), -1000);
  assert.equal(check('72019', -1001), undefined);
  assert.equal(check('72019', 10000), 10000);
  assert.equal(check('72019', 10001), undefined);
});

test('another station, parameter or statistic is ignored; a hostile id never reaches a prototype', () => {
  const at = AT;
  const result = parse([
    series({ station: 'USGS-99999999', at }),
    series({ station: '__proto__', at }),
    series({ param: '00045', at }),
    series({ param: 'constructor', at }),
    series({ statistic: '00003', at }),
    series({ statistic: null, at, tsid: 'nostat' }),
    { type: 'Feature', properties: null },
    null,
    'x',
  ]);
  assert.equal(result.total, 9);
  assert.equal(result.ignored, 8);
  assert.deepEqual(
    result.series.map((s) => s.tsid),
    ['nostat'],
  );
  assert.equal({}.polluted, undefined);
});

test('an envelope that is not a feature collection is a format error, never "no data"', () => {
  for (const text of [
    '',
    'not json',
    'null',
    '[]',
    '{"type":"Feature"}',
    '{"type":"FeatureCollection"}',
    '{"type":"FeatureCollection","features":{}}',
  ]) {
    assert.throws(() => parseLatest(text, new Set()), FormatError, text);
    assert.throws(() => parseLocations(text), FormatError, text);
  }
  const many = latestBody(Array.from({ length: 1001 }, () => series({ at: AT })));
  assert.throws(() => parseLatest(JSON.stringify(many), new Set()), FormatError);
});

test('the next link: absent, present, or invalid', () => {
  const next = { rel: 'next', href: `${BASE}/collections/latest-continuous/items?cursor=x` };
  const body = (links) => JSON.stringify(latestBody([], links));
  assert.equal(parseLatest(body([]), new Set()).next, undefined);
  assert.equal(parseLatest(body([{ rel: 'self', href: 'x' }]), new Set()).next, undefined);
  assert.equal(parseLatest(body([next]), new Set()).next, next.href);
  assert.equal(parseLatest(body([{ rel: 'next', href: 3 }]), new Set()).next, 'invalid');
  assert.equal(
    parseLatest(body([{ rel: 'next', href: 'x'.repeat(4097) }]), new Set()).next,
    'invalid',
  );
});

test('qualifiers: codes only, upper-cased, bounded; a plain string is a code', () => {
  const [s] = parse([
    series({
      at: AT,
      value: null,
      qualifier: ['ice', 'DRY', 'DRY', 'bad code', 'x'.repeat(25), 3, 'A', 'B', 'C'],
    }),
  ]).series;
  assert.deepEqual(s.qualifiers, ['ICE', 'DRY', 'A', 'B', 'C']);
  assert.equal(s.blocked, true);
  const [one] = parse([series({ at: AT, qualifier: 'Ice' })]).series;
  assert.deepEqual(one.qualifiers, ['ICE']);
  assert.equal(one.blocked, true);
});

test('qualifiersOf: the codes that only nuance a value never block it; anything else does', () => {
  assert.deepEqual(qualifiersOf(null), { codes: [], blocked: false });
  assert.deepEqual(qualifiersOf(undefined), { codes: [], blocked: false });
  assert.deepEqual(qualifiersOf([]), { codes: [], blocked: false });
  assert.deepEqual(qualifiersOf(' '), { codes: [], blocked: false });
  assert.deepEqual(qualifiersOf('ESTIMATED'), { codes: ['ESTIMATED'], blocked: false });
  assert.deepEqual(qualifiersOf(['ESTIMATED', 'REVISED']), {
    codes: ['ESTIMATED', 'REVISED'],
    blocked: false,
  });
  for (const code of [
    'DRY',
    'ICE',
    'EQUIP',
    'MAINT',
    'UNAVAIL',
    'TEST',
    'DISCONTINUED',
    'SEASONAL',
    'FLOOD',
    'DAMFAILURE',
    'ZEROFLOW',
    'LESSTHAN',
    'GREATERTHAN',
    'BLWMIN',
    'GHNOTASSCPKQ',
    'NEWCODE',
  ]) {
    assert.equal(qualifiersOf([code]).blocked, true, code);
    assert.equal(qualifiersOf(['ESTIMATED', code]).blocked, true, code);
  }
  for (const code of NUANCING) assert.equal(qualifiersOf([code]).blocked, false, code);
  // An entry that cannot be read, a number, an object: no proof the value is good.
  assert.equal(qualifiersOf(['ESTIMATED', 'bad code']).blocked, true);
  assert.equal(qualifiersOf(['ESTIMATED', 3]).blocked, true);
  assert.equal(qualifiersOf(3).blocked, true);
  assert.equal(qualifiersOf({ code: 'ESTIMATED' }).blocked, true);
  // Beyond 32 entries: not read, blocked.
  assert.equal(qualifiersOf(Array(33).fill('ESTIMATED')).blocked, true);
  assert.equal(qualifiersOf(Array(32).fill('ESTIMATED')).blocked, false);
  // A blocking code after the 8 kept is still seen.
  const many = [...'ABCDEFGH'].map((c) => `R${c}`);
  assert.equal(qualifiersOf([...NUANCING].slice(0, 9).concat(['DRY'])).blocked, true);
  assert.equal(qualifiersOf(many).codes.length, 8);
});

test('every code the real service sends is classified on purpose and has a text', () => {
  const { combinations } = JSON.parse(fixture('qualifiers.json'));
  const codes = new Set(Object.keys(combinations).flatMap((k) => k.split('|')[0].split('+')));
  assert.equal(codes.size, 27);
  const blocking = new Set([
    'BLWMIN',
    'DAMFAILURE',
    'DISCONTINUED',
    'DRY',
    'EQUIP',
    'FLOOD',
    'GHNOTASSCPKQ',
    'GREATERTHAN',
    'ICE',
    'LESSTHAN',
    'MAINT',
    'SEASONAL',
    'TEST',
    'UNAVAIL',
    'ZEROFLOW',
  ]);
  for (const code of codes) {
    assert.ok(QUALIFIER_CODES.includes(code), `${code} has a text`);
    assert.equal(qualifiersOf([code]).blocked, blocking.has(code), code);
  }
  assert.equal(blocking.size + NUANCING.size, codes.size);
});

test('selectSeries: the current one of smallest id; else a current one without value; else the latest', () => {
  const ref = AT + 10 * MINUTE;
  const max = 3 * HOUR;
  const s = (tsid, time, value, qualifiers = []) => ({ tsid, time, value, qualifiers });
  const old = s('a', AT - 7 * 365 * 24 * HOUR, 24.3);
  const b = s('b', AT, 16.2);
  const c = s('c', AT - HOUR, 16.0);
  assert.equal(selectSeries([old, c, b], ref, max, FUTURE_SLACK).series, b);
  assert.equal(selectSeries([old, c, b], ref, max, FUTURE_SLACK).state, 'fresh');
  // Two current sensors: always the same one, whatever the order or which is newer.
  assert.equal(selectSeries([c, b], ref, max, FUTURE_SLACK).series.tsid, 'b');
  assert.equal(selectSeries([b, c], ref, max, FUTURE_SLACK).series.tsid, 'b');
  const dry = s('d', AT, null, ['DRY']);
  assert.equal(selectSeries([dry, old], ref, max, FUTURE_SLACK).state, 'novalue');
  assert.equal(selectSeries([dry, b], ref, max, FUTURE_SLACK).series, b);
  assert.deepEqual(selectSeries([old], ref, max, FUTURE_SLACK), { state: 'stale', series: old });
  // Exactly at the maximum age: still current; a millisecond more: stale.
  const edge = s('e', ref - max, 1);
  assert.equal(selectSeries([edge], ref, max, FUTURE_SLACK).state, 'fresh');
  assert.equal(selectSeries([edge], ref + 1, max, FUTURE_SLACK).state, 'stale');
  // In the future beyond the slack: not dated.
  const ahead = s('f', ref + FUTURE_SLACK + 1, 1);
  assert.equal(selectSeries([ahead], ref, max, FUTURE_SLACK).state, 'unreadable');
  const near = s('g', ref + FUTURE_SLACK, 1);
  assert.equal(selectSeries([near], ref, max, FUTURE_SLACK).state, 'fresh');
  // Current but unreadable (a text): unreadable, never stale nor 0.
  assert.equal(selectSeries([s('h', AT, undefined)], ref, max, FUTURE_SLACK).state, 'unreadable');
  assert.equal(selectSeries([s('i', undefined, 3)], ref, max, FUTURE_SLACK).state, 'unreadable');
  assert.equal(selectSeries([], ref, max, FUTURE_SLACK).state, 'unreadable');
  // Several without value: the latest one is shown.
  const dry2 = s('j', AT + MINUTE, null, ['ICE']);
  assert.equal(selectSeries([dry, dry2], ref, max, FUTURE_SLACK).series, dry2);
  assert.equal(selectSeries([dry2, dry], ref, max, FUTURE_SLACK).series, dry2);
  const old2 = s('k', AT - 10 * HOUR, 1);
  assert.equal(selectSeries([old2, old], ref, max, FUTURE_SLACK).series, old2);
  assert.equal(selectSeries([old, old2], ref, max, FUTURE_SLACK).series, old2);
});

test('zones: abbreviation and daylight saving -> IANA, unknown -> UTC', () => {
  assert.equal(zoneOf('EST', 'Y'), 'America/New_York');
  assert.equal(zoneOf('EST', 'N'), 'America/New_York', 'Florida, Michigan: the flag is wrong');
  assert.equal(zoneOf('CST', 'N'), 'America/Chicago');
  assert.equal(zoneOf('PST', 'N'), 'America/Los_Angeles');
  assert.equal(zoneOf('AKST', 'Y'), 'America/Anchorage');
  assert.equal(zoneOf('AST', 'N'), 'America/Puerto_Rico');
  assert.equal(zoneOf('GST', 'N'), 'Pacific/Guam');
  assert.equal(zoneOf('ZP-11', 'N'), 'Pacific/Pago_Pago');
  assert.equal(zoneOf('zp-10', 'N'), 'Etc/GMT+10');
  assert.equal(zoneOf('ZP+10', 'N'), 'Etc/GMT-10');
  assert.equal(zoneOf('ZP-13', 'N'), 'UTC');
  assert.equal(zoneOf('ZP-0', 'N'), 'UTC');
  assert.equal(zoneOf('MST', 'Y'), 'America/Denver');
  assert.equal(zoneOf('MST', 'N'), 'America/Phoenix');
  assert.equal(zoneOf(' hst ', 'N'), 'Pacific/Honolulu');
  assert.equal(zoneOf('XYZ', 'Y'), 'UTC');
  assert.equal(zoneOf('constructor', 'Y'), 'UTC');
  assert.equal(zoneOf(undefined, 'Y'), 'UTC');
  for (const zone of ['America/New_York', 'Etc/GMT+10', 'America/Phoenix', 'Pacific/Pago_Pago']) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }));
  }
});

test('the URLs: one request for all the stations, only the parameters read (30208: discharge in m³/s)', () => {
  const url = new URL(latestUrl(BASE, ['USGS-01646500', 'USGS-09380000']));
  assert.equal(url.origin + url.pathname, `${BASE}/collections/latest-continuous/items`);
  assert.equal(url.searchParams.get('monitoring_location_id'), 'USGS-01646500,USGS-09380000');
  assert.deepEqual(url.searchParams.get('parameter_code').split(',').sort(), [
    '00010',
    '00060',
    '00065',
    '30208',
    '72019',
  ]);
  assert.equal(url.searchParams.get('limit'), '1000');
  assert.equal(url.searchParams.get('skipGeometry'), 'true');
  const loc = new URL(locationsUrl(BASE, ['USGS-01646500']));
  assert.equal(loc.searchParams.get('id'), 'USGS-01646500');
});

test('search words: letters and digits only, never a quote nor a wildcard in the filter', () => {
  assert.deepEqual(searchWords('Potomac DC'), ['POTOMAC', 'DC']);
  assert.deepEqual(searchWords("o' %_ x' OR '1'='1"), ['OR']);
  assert.deepEqual(searchWords('Rivière-du-Loup'), ['RIVIERE', 'DU', 'LOUP']);
  assert.deepEqual(searchWords('a b c d e f g h'), []);
  assert.deepEqual(searchWords('one two three four five'), ['ONE', 'TWO', 'THREE', 'FOUR']);
  assert.deepEqual(searchWords(undefined), []);
  assert.equal(searchWords('x'.repeat(50))[0].length, 30);
  const url = new URL(searchUrl(BASE, searchWords("green' river"), 15));
  assert.equal(
    url.searchParams.get('filter'),
    "monitoring_location_name LIKE '%GREEN%' AND monitoring_location_name LIKE '%RIVER%'",
  );
  assert.equal(url.searchParams.get('filter-lang'), 'cql2-text');
  assert.equal(url.searchParams.get('limit'), '15');
});

test('cleanText: control characters out, spaces folded, bounded', () => {
  assert.equal(cleanText('a\u0000b\nc\u0085d  e'), 'a b c d e');
  assert.equal(cleanText(' x '.repeat(80), 10), 'x x x x x');
  assert.equal(cleanText(3), '');
});

test('bounds: 8 qualifiers, 200 locations, series ids of safe characters', () => {
  const [s] = parse([
    series({ at: AT, value: null, qualifier: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] }),
  ]).series;
  assert.deepEqual(s.qualifiers, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const ids = parse([
    series({ at: AT, tsid: '../x' }),
    series({ at: AT, tsid: 'a'.repeat(65) }),
    series({ at: AT, tsid: 'ok_1-A' }),
  ]).series.map((x) => x.tsid);
  assert.deepEqual(ids, ['', '', 'ok_1-A']);
  const many = {
    type: 'FeatureCollection',
    features: Array.from({ length: 201 }, (_, i) => ({
      type: 'Feature',
      id: `USGS-${String(10000000 + i)}`,
      properties: { monitoring_location_name: `S${i}` },
    })),
  };
  assert.equal(parseLocations(JSON.stringify(many)).locations.size, 200);
  const odd = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: '../etc', properties: { monitoring_location_name: 'x' } },
      { type: 'Feature', id: '__proto__', properties: { monitoring_location_name: 'x' } },
      { type: 'Feature', id: 'USGS-01646500', properties: null },
    ],
  };
  assert.equal(parseLocations(JSON.stringify(odd)).locations.size, 0);
});
